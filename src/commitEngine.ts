/**
 * 提交引擎：只提交一个 changelist 的 hunks，工作区内容全程不被改写。
 *
 * 核心模型：worktree = HEAD + 全部未提交 hunks。提交 changelist C 后新 HEAD'
 * = HEAD + C 的 hunks，worktree 内容保持不动，剩余 diff 自动 = 全部 hunks − C。
 *
 * 流程（关键：全程使用临时 index，真实 index 只在最后一次性对齐）：
 *  1. 守卫：merge/rebase/cherry-pick 状态、未解决冲突、空仓库（unborn HEAD）、
 *     空 changelist、空提交信息 → 拒绝
 *  2. fresh = git diff HEAD → 解析 → 用与视图相同的匹配逻辑找出当前属于 C 的 hunks
 *  3. changelist_patch = 这些 hunks 重建的 patch
 *  4. staged_snapshot = git diff --cached → 剔除属于 C 的 hunks 得到 restore_patch
 *     （关键：用户 stage 过被 C 触碰的文件时快照必含 C 自身 hunks——git 是整文件
 *     stage——不过滤恢复必然失败；过滤后"文件保持 staged、只含剩余改动"）
 *  5. GIT_INDEX_FILE=tmp：read-tree HEAD → apply --cached changelist_patch → commit
 *     （hook 失败/崩溃只需删临时 index，HEAD 与真实 index 零损伤）
 *  6. 成功 → git reset 对齐真实 index 到新 HEAD → apply --cached restore_patch，
 *     失败走兜底阶梯：原样 → --3way → --ignore-space-change --recount → reset + 告警
 *
 * 不依赖 vscode，可在 node 环境直接测试。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  FileChange,
  Hunk,
  isBinaryContent,
  makeUntrackedChange,
  parseGitDiff,
  serializePatch,
} from './diffParser';
import { matchFileHunks, StoredHunk } from './matching';
import type { ChangelistStore } from './changelistStore';
import type { GitService } from './gitService';

/**
 * 内部 diff 固定 -U0，序列化出的 patch 无上下文行。git apply 默认拒绝
 * 零上下文 hunk（GNU patch 兼容性检查，且非文件末尾的 hunk 匹配不可靠），
 * --unidiff-zero 跳过该检查、按 hunk 头行号 + 内容精确应用——git 官方
 * 对自身生成的 -U0 patch 的建议用法。所有 apply 路径（提交/暂存/撤销）
 * 都必须带上，否则无上下文 patch 无法应用。
 */
const APPLY_CACHED = ['apply', '--cached', '--whitespace=nowarn'];

export type CommitError =
  | 'mergeInProgress'
  | 'unmerged'
  | 'noHead'
  | 'noSuchChangelist'
  | 'empty'
  | 'emptyMessage'
  | 'applyFailed'
  | 'commitFailed';

export type CommitResult =
  | { ok: true; warning?: string }
  | { ok: false; error: CommitError; stderr?: string };

export interface CommitEngineOptions {
  git: GitService;
  store: ChangelistStore;
  repoRoot: string;
  changelistId: string;
  message: string;
}

export async function commitChangelist(opts: CommitEngineOptions): Promise<CommitResult> {
  const { git, store, repoRoot, changelistId, message } = opts;

  // ---- 1. 守卫 ----
  if (!message.trim()) {
    return { ok: false, error: 'emptyMessage' };
  }
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const cl = store.changelistsOf(repoRoot).find((c) => c.id === changelistId);
  if (!cl) {
    return { ok: false, error: 'noSuchChangelist' };
  }

  // ---- 2/3. 收集当前属于 C 的 hunks ----
  const built = await buildChangelistPatch(git, store, repoRoot, changelistId);
  if (!built) {
    return { ok: false, error: 'empty' };
  }
  return commitPatchToIndex(git, repoRoot, built.patch, built.committedIds, message);
}

/** 提交 default（未分配）下的全部改动 */
export async function commitUnassigned(opts: {
  git: GitService;
  store: ChangelistStore;
  repoRoot: string;
  message: string;
}): Promise<CommitResult> {
  const { git, store, repoRoot, message } = opts;
  if (!message.trim()) {
    return { ok: false, error: 'emptyMessage' };
  }
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const built = await buildUnassignedPatch(git, store, repoRoot);
  if (!built) {
    return { ok: false, error: 'empty' };
  }
  return commitPatchToIndex(git, repoRoot, built.patch, built.committedIds, message);
}

/**
 * 临时 index 提交 patch → 成功后一次性对齐真实 index。
 * 未分配 hunks 在 store 无记录，committedIds 为空 → restore 不需要过滤（已暂存的
 * 未分配 hunk 无法区分，保持 git 原生语义：提交不触碰 staged 状态之外的内容）。
 */
async function commitPatchToIndex(
  git: GitService,
  repoRoot: string,
  patch: string,
  committedIds: Map<string, Set<string>>,
  message: string,
): Promise<{ ok: true; warning?: string } | { ok: false; error: 'applyFailed' | 'commitFailed'; stderr?: string }> {
  // ---- 4. restore_patch = 已有 staged 状态 剔除 C 的 hunks ----
  const staged = parseGitDiff(await git.diffStaged(repoRoot));
  const restoreFiles: FileChange[] = [];
  let skipNewFile = false;
  for (const fc of staged) {
    const committed = committedIds.get(fc.path);
    if (fc.kind === 'new' && committed) {
      // 该文件已被本次提交写进新 HEAD。若旧 staged 版本与提交版本内容不同
      // （stage 后又编辑再提交），恢复旧版会与已存在文件冲突导致 restore 失败，
      // 且恢复出的内容也已过时——直接跳过，staged 状态由 reset 自然清空。
      // 版本一致时 keep 过滤已剔除，此处只兜住内容变化的场景。
      if (fc.hunks.length > 0 && !committed.has(fc.hunks[0].id)) {
        skipNewFile = true;
      }
      continue;
    }
    const keep = fc.hunks.filter((h) => !committed?.has(h.id));
    if (keep.length > 0) {
      restoreFiles.push({ ...fc, hunks: keep });
    }
  }
  // F5A：restore 应用目标是新 HEAD（含被提交 hunks），与 diffStaged 的 index
  // 坐标不一致时纯插入 hunk 会静默错位——重跑 fresh 拿被提交 hunk 的内容修正。
  // fresh 与 build 时可能隔了几毫秒（hunk id 理论上会变），修正失效时退化为
  // 原行为（错位），不影响提交本身。
  fixRestoreInsertionCoords(await freshDiff(git, repoRoot), staged, committedIds, restoreFiles);
  const restorePatch = serializePatch(restoreFiles);

  // ---- 5. 临时 index 提交 ----
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'changelists-plus-'));
  const tmpIndex = path.join(tmpDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    const rt = await git.run(['read-tree', 'HEAD'], { cwd: repoRoot, env });
    if (rt.code !== 0) {
      return { ok: false, error: 'applyFailed', stderr: rt.stderr };
    }
    const ap = await git.run([...APPLY_CACHED, '--unidiff-zero'], {
      cwd: repoRoot,
      env,
      input: patch,
    });
    if (ap.code !== 0) {
      return { ok: false, error: 'applyFailed', stderr: ap.stderr };
    }
    const cr = await git.run(['commit', '-m', message], { cwd: repoRoot, env });
    if (cr.code !== 0) {
      return { ok: false, error: 'commitFailed', stderr: cr.stderr };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---- 6. 对齐真实 index ----
  await git.run(['reset', '-q'], { cwd: repoRoot });
  let warning: string | undefined;
  if (skipNewFile) {
    warning = 'restoreFailed'; // 部分 staged 状态未恢复（new-file 已被提交，语义无害）
  }
  if (restorePatch.trim().length > 0) {
    const applied = await applyWithFallbacks(git, repoRoot, restorePatch);
    if (!applied.ok) {
      // 兜底底线：reset 只丢失 staged 状态，worktree 内容从未被动过
      await git.run(['reset', '-q'], { cwd: repoRoot });
      warning = 'restoreFailed';
    }
  }
  return { ok: true, warning };
}

async function applyWithFallbacks(
  git: GitService,
  repoRoot: string,
  patch: string,
): Promise<{ ok: boolean; stderr: string }> {
  // 所有阶梯都带 --unidiff-zero：内部 diff 为 -U0，patch 无上下文行，
  // git apply 默认拒绝（GNU patch 兼容检查），该标志跳过检查、按行号精确应用
  const attempts: string[][] = [
    [...APPLY_CACHED, '--unidiff-zero'],
    [...APPLY_CACHED, '--unidiff-zero', '--3way'],
    [...APPLY_CACHED, '--unidiff-zero', '--ignore-space-change', '--recount'],
  ];
  let stderr = '';
  for (const args of attempts) {
    const r = await git.run(args, { cwd: repoRoot, input: patch });
    if (r.code === 0) {
      return { ok: true, stderr: '' };
    }
    stderr = r.stderr;
  }
  // --3way 阶梯失败时 git 会把冲突文件标记为 UU 并部分写入真实 index
  // （实验验证：exit=1 但 index 已被污染，后续 diff/apply 都看到脏状态）。
  // 只重置冲突路径清理污染，不碰其他文件的已暂存状态。
  await resetUnmergedPaths(git, repoRoot);
  return { ok: false, stderr };
}

/** 把 index 中未合并（3way 冲突残留的 UU）路径重置回 HEAD，清除 apply 污染 */
async function resetUnmergedPaths(git: GitService, repoRoot: string): Promise<void> {
  const r = await git.run(['ls-files', '-u', '-z'], { cwd: repoRoot });
  if (r.code !== 0 || !r.stdout.trim()) {
    return;
  }
  const paths: string[] = [];
  for (const entry of r.stdout.split('\0')) {
    if (!entry) {
      continue;
    }
    // 格式：<mode> <object> <stage>\t<path>（-z 下条目间以 NUL 分隔）
    const m = /^\S+ \S+ \S+\t(.*)$/.exec(entry);
    if (m) {
      paths.push(m[1]);
    }
  }
  if (paths.length === 0) {
    return;
  }
  // 文件名含 * ? [ 时按字面处理（同 diffFile 的 literalPathspec 思路）
  await git.run(['reset', '-q', '--', ...paths.map((p) => ':(literal)' + p)], { cwd: repoRoot });
}

/**
 * 修正暂存 patch 中纯插入 hunk（oldLines=0）的 newStart（stage 场景）。
 *
 * git apply 对 oldLines=0 的 hunk 没有内容锚点：不做内容校验、直接按 hunk 头
 * newStart 行前插入，位置错了也是 exit=0 的静默错位（实验验证）。fresh diff 的
 * newStart 是 worktree 坐标（含所有未提交 hunks），而 apply 目标是 index（只含
 * 已暂存 hunks）——上方「未暂存且不在本次 patch 内」的 hunk 行只在 worktree 有、
 * index 没有，插入点会偏掉其 (newLines - oldLines) 行，需要减掉：
 * - 已暂存 hunks：index 中有 → 两侧坐标一致，不偏移
 * - patch 内前序 hunks：git apply 按应用前序 hunk 后的内容定位，自动累计
 * - 删除/修改 hunk（oldLines>0）：有 '-' 内容行做锚点，git 自动偏移搜索，无需修正
 */
function fixStageInsertionCoords(
  fresh: FileChange[],
  chosenIdsByPath: ReadonlyMap<string, ReadonlySet<string>>,
  stagedIdsByPath: ReadonlyMap<string, ReadonlySet<string>>,
): void {
  for (const fc of fresh) {
    const chosen = chosenIdsByPath.get(fc.path);
    if (!chosen) {
      continue;
    }
    const staged = stagedIdsByPath.get(fc.path);
    for (const h of fc.hunks) {
      if (h.oldLines !== 0 || !chosen.has(h.id)) {
        continue;
      }
      let offset = 0;
      for (const u of fc.hunks) {
        if (u.oldStart > h.oldStart) {
          break; // fc.hunks 按文件顺序排列（oldStart 非降序）
        }
        if (u === h) {
          continue;
        }
        if (staged?.has(u.id)) {
          continue; // 已暂存：index 两侧都有
        }
        if (chosen.has(u.id)) {
          continue; // 本次 patch 内：git apply 自动累计
        }
        offset += u.newLines - u.oldLines;
      }
      if (offset !== 0) {
        h.header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart - offset},${h.newLines} @@`;
      }
    }
  }
}

/**
 * 修正 restore_patch 中纯插入 hunk 的 newStart（提交后恢复暂存）。
 * restore_patch 基线是 diffStaged（index 坐标），应用目标是新 HEAD
 * （HEAD + 被提交 hunks）。「被提交且未暂存」的 hunk（用户没 stage 就提交了它）
 * 的行只存在于新 HEAD，插入点需后移其 (newLines - oldLines)：
 * - 已暂存后提交的：index 与新 HEAD 都有 → 两侧坐标一致
 * - patch 内前序 hunk（restore 保留的）：git apply 自动累计
 * - 删除/修改 hunk：有内容锚点，git 自动偏移，无需修正
 */
function fixRestoreInsertionCoords(
  fresh: FileChange[],
  staged: FileChange[],
  committedIds: ReadonlyMap<string, ReadonlySet<string>>,
  restoreFiles: FileChange[],
): void {
  for (const rc of restoreFiles) {
    if (rc.kind === 'new') {
      continue; // 新文件整体处理（或跳过），无坐标问题
    }
    const committed = committedIds.get(rc.path);
    if (!committed) {
      continue;
    }
    const stagedFc = staged.find((s) => s.path === rc.path);
    const freshFc = fresh.find((f) => f.path === rc.path);
    if (!stagedFc || !freshFc) {
      continue;
    }
    const restoredIds = new Set(rc.hunks.map((h) => h.id));
    for (const h of rc.hunks) {
      if (h.oldLines !== 0) {
        continue;
      }
      let offset = 0;
      for (const u of freshFc.hunks) {
        if (u.oldStart > h.oldStart) {
          break; // freshFc.hunks 按文件顺序排列（oldStart 非降序）
        }
        if (!committed.has(u.id)) {
          continue; // 未提交：不在新 HEAD，不偏移
        }
        if (stagedFc.hunks.some((s) => s.id === u.id)) {
          continue; // 已暂存后提交：新 HEAD 与 index 都有，坐标一致
        }
        if (restoredIds.has(u.id)) {
          continue; // patch 内前序：git apply 自动累计
        }
        offset += u.newLines - u.oldLines;
      }
      if (offset !== 0) {
        h.header = `@@ -${h.oldStart},${h.oldLines} +${h.newStart + offset},${h.newLines} @@`;
      }
    }
  }
}

/** 守卫：merge/rebase/cherry-pick 状态、未解决冲突、空仓库（unborn HEAD） */
async function guardRepo(
  git: GitService,
  repoRoot: string,
): Promise<'mergeInProgress' | 'unmerged' | 'noHead' | null> {
  // 全部检查并行（状态文件一次 rev-parse 取全部 + unmerged + HEAD），
  // 低配机省掉串行排队；结果按原优先级返回（merge 状态 > 冲突 > unborn），语义不变
  const [inProgress, unmerged, headExists] = await Promise.all([
    git
      .guardPathsExist(repoRoot, ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'])
      .then((found) => found.some(Boolean)),
    git.hasUnmerged(repoRoot),
    git.headExists(repoRoot),
  ]);
  if (inProgress) {
    return 'mergeInProgress';
  }
  if (unmerged) {
    return 'unmerged';
  }
  if (!headExists) {
    return 'noHead';
  }
  return null;
}

/**
 * worktree vs HEAD 全量 diff，并按与视图相同的方式合成未跟踪文件。
 * 内容哈希与视图完全一致，保证匹配结果一致。
 */
async function freshDiff(git: GitService, repoRoot: string): Promise<FileChange[]> {
  // diffWorktree 与 untrackedFiles 互不依赖，并行省 1 轮 git 进程
  const [diffText, untracked] = await Promise.all([
    git.diffWorktree(repoRoot),
    git.untrackedFiles(repoRoot),
  ]);
  const fresh: FileChange[] = parseGitDiff(diffText);
  const freshPaths = new Set(fresh.map((f) => f.path));
  for (const rel of untracked) {
    if (freshPaths.has(rel)) {
      continue;
    }
    try {
      const buf = fs.readFileSync(path.join(repoRoot, rel));
      if (!isBinaryContent(buf)) {
        fresh.push(makeUntrackedChange(rel, buf.toString('utf8')));
      }
    } catch {
      /* 扫描间隙被删除 */
    }
  }
  return fresh;
}

export interface ChangelistPatch {
  /** 只含该 changelist hunks 的 patch（基于 HEAD 基线） */
  patch: string;
  /** filePath → 命中的 hunk ids（restore_patch 过滤用） */
  committedIds: Map<string, Set<string>>;
}

/** 收集当前 diff 中属于 changelistId 的 hunks 并重建为 patch；无可收集 → null */
export async function buildChangelistPatch(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
  changelistId: string,
): Promise<ChangelistPatch | null> {
  const fresh = await freshDiff(git, repoRoot);
  const committedIds = new Map<string, Set<string>>();
  const patchFiles: FileChange[] = [];
  for (const fc of fresh) {
    const withOwner = store.recordsWithOwner(repoRoot, fc.path);
    const { owners, updates } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    store.updatePositions(
      repoRoot,
      updates.map((u) => ({ path: fc.path, ...u })),
    );
    const ownerOf = new Map(withOwner.map((w) => [w.record, w.ownerId]));
    const chosen: FileChange['hunks'] = [];
    for (let i = 0; i < fc.hunks.length; i++) {
      const rec = owners[i];
      if (rec && ownerOf.get(rec) === changelistId) {
        chosen.push(fc.hunks[i]);
        let ids = committedIds.get(fc.path);
        if (!ids) {
          ids = new Set();
          committedIds.set(fc.path, ids);
        }
        ids.add(fc.hunks[i].id);
      }
    }
    if (chosen.length > 0) {
      patchFiles.push({ ...fc, hunks: chosen });
    }
  }
  if (patchFiles.length === 0) {
    return null;
  }
  return { patch: serializePatch(patchFiles), committedIds };
}

// ================= 按视图收集单文件 hunks（diff 视图用） =================

export interface FilePatchResult {
  /** 只含该视图 hunks 的 patch（基于 HEAD 基线） */
  patch: string;
  /** 命中的 store 记录 id（撤销后清理用；未分配的 hunk 没有记录，不会出现） */
  recordIds: string[];
  /** patch 中的 hunk 数 */
  count: number;
}

/**
 * 收集单个文件中满足 owner 过滤条件的当前 hunks，重建为基于 HEAD 的 patch。
 * 未匹配到 store 记录的 hunk 视为未分配（ownerFilter(null)）。
 * 用于「点击 changelist 下的文件只看该 changelist 修改」的 diff 视图与按视图撤销。
 *
 * 性能：只做**单文件** git 调用（diffFile / isUntracked），不走全量 freshDiff——
 * 低配置机器 / 大仓库下「打开 diff 视图」卡顿的主因是点击一个文件却全仓扫描。
 */
export async function buildFilePatch(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
  relPath: string,
  ownerFilter: (ownerId: string | null) => boolean,
): Promise<FilePatchResult | null> {
  let fc: FileChange | undefined;
  if (await git.isUntracked(repoRoot, relPath)) {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(repoRoot, relPath));
    } catch {
      return null; // 文件在扫描间隙被删除
    }
    if (isBinaryContent(buf)) {
      return null; // 二进制未跟踪文件无可分配 hunks
    }
    fc = makeUntrackedChange(relPath, buf.toString('utf8'));
  } else {
    // 已跟踪文件：单文件 pathspec diff（文件名含 * ? [ 已按字面处理，见 literalPathspec）
    fc = parseGitDiff(await git.diffFile(repoRoot, relPath)).find((c) => c.path === relPath);
  }
  if (!fc) {
    return null;
  }
  const withOwner = store.recordsWithOwner(repoRoot, relPath);
  const { owners } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
  const ownerOf = new Map(withOwner.map((w) => [w.record, w.ownerId]));
  const recordIds: string[] = [];
  const chosen = fc.hunks.filter((h, i) => {
    const rec = owners[i];
    if (!rec) {
      return ownerFilter(null);
    }
    if (!ownerFilter(ownerOf.get(rec) ?? null)) {
      return false;
    }
    recordIds.push(rec.id);
    return true;
  });
  if (chosen.length === 0) {
    return null;
  }
  return { patch: serializePatch([{ ...fc, hunks: chosen }]), recordIds, count: chosen.length };
}

/**
 * 收集当前 diff 中**未分配**（default 视图）的所有 hunks，重建为基于 HEAD 的 patch。
 * 与 buildFilePatch 同一匹配体系：未匹配到 store 记录的 hunk 视为未分配。
 * committedIds 填被提交 hunks 的**内容哈希 id**（当前 hunk 的 id，与 store 无关）——
 * restore_patch 用它过滤 staged 快照：用户已暂存的未分配 hunk 提交后不需要再恢复。
 */
export async function buildUnassignedPatch(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
): Promise<ChangelistPatch | null> {
  const fresh = await freshDiff(git, repoRoot);
  const committedIds = new Map<string, Set<string>>();
  const patchFiles: FileChange[] = [];
  for (const fc of fresh) {
    const withOwner = store.recordsWithOwner(repoRoot, fc.path);
    const { owners } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    const chosen = fc.hunks.filter((h, i) => !owners[i]);
    if (chosen.length > 0) {
      patchFiles.push({ ...fc, hunks: chosen });
      committedIds.set(
        fc.path,
        new Set(chosen.map((h) => h.id)),
      );
    }
  }
  if (patchFiles.length === 0) {
    return null;
  }
  return { patch: serializePatch(patchFiles), committedIds };
}

// ================= 暂存（stage） =================

export type StageError = 'mergeInProgress' | 'unmerged' | 'noHead' | 'empty' | 'applyFailed';

export type StageResult =
  | { ok: true; stagedCount: number }
  | { ok: false; error: StageError; stderr?: string };

/**
 * 把指定的 hunk 记录暂存到真实 index（`git apply --cached`），工作区文件不动。
 * 记录 id 是内容哈希（与视图的 hunk.id 同一体系），直接与 fresh diff 匹配——
 * 不需要经过 store（未分配的 hunk 在 store 中没有记录，但同样可暂存）。
 * 与提交不同：stage 失败时**绝不 reset**——apply 失败是原子的，index 保持原样，
 * 不会丢掉用户已有的暂存状态。
 */
/**
 * 暂存指定 hunks 到 index。
 * fresh 可选：调用方（stageChangelist / stageUnassigned）收集记录时已算过全量
 * freshDiff，直接传入复用——同一批次内 worktree 无写入，两遍全量 diff 结果相同，
 * 低配机 / 大仓库下避免重复扫描。未传时自己算（stageHunk 等单文件入口）。
 * guarded 可选：调用方已跑过 guardRepo（stageChangelist / stageUnassigned 都在
 * 收集 fresh 前 guard 过）时传 true，跳过内部重复 guard——guardRepo 一次
 * 3 个 git 进程，每次暂存都省一轮。未传（false）保持内部 guard（stageHunk）。
 */
export async function stageRecords(
  git: GitService,
  repoRoot: string,
  records: Map<string, StoredHunk[]>,
  fresh?: FileChange[],
  guarded = false,
): Promise<StageResult> {
  if (!guarded) {
    const guardErr = await guardRepo(git, repoRoot);
    if (guardErr) {
      return { ok: false, error: guardErr };
    }
  }
  const freshChanges = fresh ?? (await freshDiff(git, repoRoot));
  // 已暂存的 hunk 不再重复应用（幂等 no-op）——避免对已 staged 内容 apply 报"改动已变化"；
  // diffStaged 只取 records 涉及的文件（pathspec 限制），大仓库下省掉全量 staged diff
  const stagedIdsByPath = new Map<string, Set<string>>();
  for (const fc of parseGitDiff(await git.diffStaged(repoRoot, [...records.keys()]))) {
    stagedIdsByPath.set(fc.path, new Set(fc.hunks.map((h) => h.id)));
  }
  const wantByPath = new Map<string, Set<string>>();
  for (const [p, recs] of records) {
    wantByPath.set(p, new Set(recs.map((r) => r.id)));
  }
  const patchFiles: FileChange[] = [];
  const chosenIdsByPath = new Map<string, Set<string>>();
  let stagedCount = 0;
  for (const fc of freshChanges) {
    const wantIds = wantByPath.get(fc.path);
    if (!wantIds) {
      continue;
    }
    const stagedIds = stagedIdsByPath.get(fc.path);
    const chosen = fc.hunks.filter((h) => wantIds.has(h.id) && !stagedIds?.has(h.id));
    if (chosen.length > 0) {
      patchFiles.push({ ...fc, hunks: chosen });
      chosenIdsByPath.set(fc.path, new Set(chosen.map((h) => h.id)));
      stagedCount += chosen.length;
    }
  }
  if (patchFiles.length === 0) {
    // 全部已暂存：幂等成功（区别于"没有可暂存的改动"）
    return { ok: true, stagedCount: 0 };
  }
  // F1：fresh 坐标含所有 worktree 改动，apply 目标是 index（只含已暂存）——
  // 纯插入 hunk 的 newStart 修正，否则上方未暂存改动会让插入点静默错位
  fixStageInsertionCoords(freshChanges, chosenIdsByPath, stagedIdsByPath);
  const applied = await applyWithFallbacks(git, repoRoot, serializePatch(patchFiles));
  if (!applied.ok) {
    return { ok: false, error: 'applyFailed', stderr: applied.stderr };
  }
  return { ok: true, stagedCount };
}

/**
 * 收集 fresh diff 中属于指定 changelist 的 hunks 记录（与 buildChangelistPatch
 * 同一匹配体系：内容哈希优先、位置回退）。收集与 stageRecords 共享同一份 fresh，
 * 避免 stageChangelist 里全量 diff 跑两遍。
 */
function collectRecordsForOwner(
  fresh: FileChange[],
  store: ChangelistStore,
  repoRoot: string,
  changelistId: string,
): Map<string, StoredHunk[]> {
  const records = new Map<string, StoredHunk[]>();
  for (const fc of fresh) {
    const withOwner = store.recordsWithOwner(repoRoot, fc.path);
    const { owners } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    const ownerOf = new Map(withOwner.map((w) => [w.record, w.ownerId]));
    const chosen: Hunk[] = [];
    for (let i = 0; i < fc.hunks.length; i++) {
      const rec = owners[i];
      if (rec && ownerOf.get(rec) === changelistId) {
        chosen.push(fc.hunks[i]);
      }
    }
    if (chosen.length > 0) {
      records.set(
        fc.path,
        chosen.map((h) => ({ id: h.id, oldStart: h.oldStart, oldLines: h.oldLines })),
      );
    }
  }
  return records;
}

/** 暂存 default（未分配）下的全部当前 hunks */
export async function stageUnassigned(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
): Promise<StageResult> {
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const fresh = await freshDiff(git, repoRoot);
  const records = new Map<string, StoredHunk[]>();
  for (const fc of fresh) {
    const withOwner = store.recordsWithOwner(repoRoot, fc.path);
    const { owners } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    const unassigned = fc.hunks.filter((h, i) => !owners[i]);
    if (unassigned.length > 0) {
      records.set(
        fc.path,
        unassigned.map((h) => ({ id: h.id, oldStart: h.oldStart, oldLines: h.oldLines })),
      );
    }
  }
  if (records.size === 0) {
    return { ok: false, error: 'empty' };
  }
  // fresh 复用：收集与 stageRecords 各算一遍全量 diff 是同一内容；
  // guarded 复用：上方已 guardRepo，stageRecords 内不再重复跑
  return stageRecords(git, repoRoot, records, fresh, true);
}

/** 暂存一个 changelist 的全部当前 hunks */
export async function stageChangelist(opts: {
  git: GitService;
  store: ChangelistStore;
  repoRoot: string;
  changelistId: string;
}): Promise<StageResult> {
  const { git, store, repoRoot, changelistId } = opts;
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const fresh = await freshDiff(git, repoRoot);
  const records = collectRecordsForOwner(fresh, store, repoRoot, changelistId);
  if (records.size === 0) {
    return { ok: false, error: 'empty' };
  }
  // fresh 复用 + 走 stageRecords 的「已暂存 hunk 过滤」逻辑（重复暂存 → 幂等 no-op）；
  // guarded 复用：上方已 guardRepo，stageRecords 内不再重复跑
  return stageRecords(git, repoRoot, records, fresh, true);
}

// ================= 撤销（discard，按视图） =================

export type DiscardError = 'mergeInProgress' | 'unmerged' | 'noHead' | 'empty' | 'applyFailed';

export type DiscardResult =
  | { ok: true; count: number; warning?: string }
  | { ok: false; error: DiscardError; stderr?: string };

/**
 * 撤销某个视图（Unassigned / 某 changelist）下指定文件的全部修改：
 * 把该视图的 hunks 从 worktree 中移除，其他视图的修改不受影响。
 * - 已跟踪文件：基于 HEAD 基线的反向 patch（git apply -R），带兜底阶梯；
 *   失败绝不 reset、绝不硬删内容（与 stage 同哲学）
 * - 未跟踪文件：该视图的 hunks 即整个新文件，撤销 = 删除文件
 * 成功后移除该视图的 store 记录（hunk 已不存在；未分配的 hunk 本无记录）。
 */
export async function discardViewChanges(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
  relPath: string,
  view: 'unassigned' | string,
): Promise<DiscardResult> {
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const built = await buildFilePatch(
    git,
    store,
    repoRoot,
    relPath,
    view === 'unassigned' ? (o) => o === null : (o) => o === view,
  );
  if (!built) {
    return { ok: false, error: 'empty' };
  }
  if (await git.isUntracked(repoRoot, relPath)) {
    try {
      fs.rmSync(path.join(repoRoot, relPath));
    } catch (err) {
      return { ok: false, error: 'applyFailed', stderr: String(err) };
    }
  } else {
    // --unidiff-zero：-U0 无上下文 patch 必需（见 APPLY_CACHED 注释）
    const attempts: string[][] = [
      ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn'],
      ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', '--3way'],
      ['apply', '-R', '--unidiff-zero', '--whitespace=nowarn', '--ignore-space-change', '--recount'],
    ];
    let stderr = '';
    let ok = false;
    for (const args of attempts) {
      const r = await git.run(args, { cwd: repoRoot, input: built.patch });
      if (r.code === 0) {
        ok = true;
        break;
      }
      stderr = r.stderr;
    }
    if (!ok) {
      return { ok: false, error: 'applyFailed', stderr };
    }
    // 同步 index：已暂存的 hunk 一并撤销，避免留下 stale staged 状态。
    // 未暂存的 hunk 在 index 中是 HEAD 版本，反向 patch 上下文不匹配 → 自然失败，忽略。
    const sync = await git.run(['apply', '--cached', '-R', '--unidiff-zero', '--whitespace=nowarn'], {
      cwd: repoRoot,
      input: built.patch,
    });
    if (sync.code !== 0) {
      // F6：失败可能是"已暂存的同 hunk 未能移除"（stale 残留）。用 diffStaged
      // 复核——patch 中还有 hunk 留在 index 才警告，纯未暂存场景的失败是预期的。
      const leftover = parseGitDiff(await git.diffStaged(repoRoot)).find((f) => f.path === relPath);
      const leftoverIds = new Set(leftover?.hunks.map((h) => h.id) ?? []);
      const patchIds = parseGitDiff(built.patch).flatMap((f) => f.hunks.map((h) => h.id));
      if (patchIds.some((id) => leftoverIds.has(id))) {
        return { ok: true, count: built.count, warning: 'discardStagedSyncFailed' };
      }
    }
  }
  if (built.recordIds.length > 0) {
    store.removeRecords(repoRoot, relPath, built.recordIds);
  }
  return { ok: true, count: built.count };
}

/** 撤销某个 changelist 下全部文件的全部修改；其他视图的 hunks 不受影响 */
export async function discardChangelist(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
  changelistId: string,
): Promise<DiscardResult> {
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const fresh = await freshDiff(git, repoRoot);
  let count = 0;
  for (const fc of fresh) {
    const withOwner = store.recordsWithOwner(repoRoot, fc.path);
    const { owners } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    const ownerOf = new Map(withOwner.map((w) => [w.record, w.ownerId]));
    if (!fc.hunks.some((h, i) => owners[i] && ownerOf.get(owners[i] as StoredHunk) === changelistId)) {
      continue;
    }
    const r = await discardViewChanges(git, store, repoRoot, fc.path, changelistId);
    if (!r.ok) {
      return r;
    }
    count += r.count;
  }
  if (count === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, count };
}

/** 撤销 default（未分配）下全部文件的全部修改；已分配的 hunks 不受影响 */
export async function discardUnassigned(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
): Promise<DiscardResult> {
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const fresh = await freshDiff(git, repoRoot);
  let count = 0;
  for (const fc of fresh) {
    const withOwner = store.recordsWithOwner(repoRoot, fc.path);
    const { owners } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    if (!fc.hunks.some((h, i) => !owners[i])) {
      continue;
    }
    const r = await discardViewChanges(git, store, repoRoot, fc.path, 'unassigned');
    if (!r.ok) {
      return r;
    }
    count += r.count;
  }
  if (count === 0) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, count };
}
