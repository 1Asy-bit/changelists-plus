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
  for (const fc of staged) {
    const committed = committedIds.get(fc.path);
    const keep = fc.hunks.filter((h) => !committed?.has(h.id));
    if (keep.length > 0) {
      restoreFiles.push({ ...fc, hunks: keep });
    }
  }
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
  return { ok: false, stderr };
}

/** 守卫：merge/rebase/cherry-pick 状态、未解决冲突、空仓库（unborn HEAD） */
async function guardRepo(
  git: GitService,
  repoRoot: string,
): Promise<'mergeInProgress' | 'unmerged' | 'noHead' | null> {
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await git.guardPathExists(repoRoot, name)) {
      return 'mergeInProgress';
    }
  }
  if (await git.hasUnmerged(repoRoot)) {
    return 'unmerged';
  }
  if (!(await git.headExists(repoRoot))) {
    return 'noHead';
  }
  return null;
}

/**
 * worktree vs HEAD 全量 diff，并按与视图相同的方式合成未跟踪文件。
 * 内容哈希与视图完全一致，保证匹配结果一致。
 */
async function freshDiff(git: GitService, repoRoot: string): Promise<FileChange[]> {
  const fresh: FileChange[] = parseGitDiff(await git.diffWorktree(repoRoot));
  const freshPaths = new Set(fresh.map((f) => f.path));
  for (const rel of await git.untrackedFiles(repoRoot)) {
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
 */
export async function buildFilePatch(
  git: GitService,
  store: ChangelistStore,
  repoRoot: string,
  relPath: string,
  ownerFilter: (ownerId: string | null) => boolean,
): Promise<FilePatchResult | null> {
  const fresh = await freshDiff(git, repoRoot);
  const fc = fresh.find((f) => f.path === relPath);
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
export async function stageRecords(
  git: GitService,
  repoRoot: string,
  records: Map<string, StoredHunk[]>,
): Promise<StageResult> {
  const guardErr = await guardRepo(git, repoRoot);
  if (guardErr) {
    return { ok: false, error: guardErr };
  }
  const fresh = await freshDiff(git, repoRoot);
  // 已暂存的 hunk 不再重复应用（幂等 no-op）——避免对已 staged 内容 apply 报"改动已变化"
  const stagedIdsByPath = new Map<string, Set<string>>();
  for (const fc of parseGitDiff(await git.diffStaged(repoRoot))) {
    stagedIdsByPath.set(fc.path, new Set(fc.hunks.map((h) => h.id)));
  }
  const wantByPath = new Map<string, Set<string>>();
  for (const [p, recs] of records) {
    wantByPath.set(p, new Set(recs.map((r) => r.id)));
  }
  const patchFiles: FileChange[] = [];
  let stagedCount = 0;
  for (const fc of fresh) {
    const wantIds = wantByPath.get(fc.path);
    if (!wantIds) {
      continue;
    }
    const stagedIds = stagedIdsByPath.get(fc.path);
    const chosen = fc.hunks.filter((h) => wantIds.has(h.id) && !stagedIds?.has(h.id));
    if (chosen.length > 0) {
      patchFiles.push({ ...fc, hunks: chosen });
      stagedCount += chosen.length;
    }
  }
  if (patchFiles.length === 0) {
    // 全部已暂存：幂等成功（区别于"没有可暂存的改动"）
    return { ok: true, stagedCount: 0 };
  }
  const applied = await applyWithFallbacks(git, repoRoot, serializePatch(patchFiles));
  if (!applied.ok) {
    return { ok: false, error: 'applyFailed', stderr: applied.stderr };
  }
  return { ok: true, stagedCount };
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
  return stageRecords(git, repoRoot, records);
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
  const built = await buildChangelistPatch(git, store, repoRoot, changelistId);
  if (!built) {
    return { ok: false, error: 'empty' };
  }
  // 走 stageRecords：复用「已暂存 hunk 过滤」逻辑（重复暂存同一 changelist → 幂等 no-op）
  const records = new Map<string, StoredHunk[]>();
  for (const [p, ids] of built.committedIds) {
    records.set(
      p,
      [...ids].map((id) => ({ id, oldStart: 0, oldLines: 0 })),
    );
  }
  return stageRecords(git, repoRoot, records);
}

// ================= 撤销（discard，按视图） =================

export type DiscardError = 'mergeInProgress' | 'unmerged' | 'noHead' | 'empty' | 'applyFailed';

export type DiscardResult =
  | { ok: true; count: number }
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
    await git.run(['apply', '--cached', '-R', '--unidiff-zero', '--whitespace=nowarn'], {
      cwd: repoRoot,
      input: built.patch,
    });
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
