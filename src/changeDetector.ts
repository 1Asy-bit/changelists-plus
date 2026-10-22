/**
 * 变更检测器：把 git 仓库的当前 diff 与 store 中的分配记录合并成视图模型。
 * - 全量刷新（refreshAll）与单文件刷新（refreshFile）两条路径
 * - 每次刷新都重新匹配：内容哈希优先、位置回退（见 matching.ts）
 * - stale 清理：连续两个刷新周期都匹配不到的记录才从 store 删除（防闪烁）
 * - 通过 EventEmitter 的 'change' 事件通知模型变化
 * - 不依赖 vscode（workspace 文件夹列表由外部注入）
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { GitService } from './gitService';
import type { ChangelistStore } from './changelistStore';
import {
  FileChange,
  Hunk,
  isBinaryContent,
  makeUntrackedChange,
  parseGitDiff,
} from './diffParser';
import { matchFileHunks, StoredHunk } from './matching';
import { looksLikeRepoRoot, scanForGitDirs } from './repoDiscovery';

/** 归一符号链接（macOS /tmp、/var 等）；文件已不存在时保持原路径 */
export function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 路径比较键（仅用于比较，不作存储 key——store 的 repo key 保持 git 原始输出
 * 形式，存量用户数据不受影响）：realpath 归一符号链接（macOS /tmp→/private/tmp）、
 * path.normalize 统一分隔符（git for Windows 的 rev-parse 输出正斜杠）、
 * Windows 大小写折叠（文件系统大小写不敏感）。
 */
function normKey(s: string): string {
  const n = path.normalize(realpathSafe(s));
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** key 是否等于 rk 或位于其下（段边界安全；两侧均已 normalize，分隔符与 path.sep 一致） */
function underOrEq(key: string, rk: string): boolean {
  if (key === rk) {
    return true;
  }
  // rk 已是文件系统根（POSIX '/' / Windows 'C:\'）时末尾自带分隔符，再拼一段
  // 会得到 '//' / 'C:\\' 导致所有子路径前缀匹配失败
  const prefix = rk.endsWith(path.sep) ? rk : rk + path.sep;
  return key.startsWith(prefix);
}

/** 从 dir 向上找最近存在的目录（目标文件/目录可能已被删除，spawn 的 cwd 必须存在） */
function nearestExistingDir(dir: string): string | null {
  let d = dir;
  for (let i = 0; i < 30; i++) {
    // 上限防病理深树
    try {
      if (fs.statSync(d).isDirectory()) {
        return d;
      }
    } catch {
      /* 不存在则继续向上 */
    }
    const parent = path.dirname(d);
    if (parent === d) {
      return null;
    }
    d = parent;
  }
  return null;
}

export interface HunkOwnerModel {
  hunk: Hunk;
  ownerId: string | null;
}

export interface FileModel {
  change: FileChange;
  hunks: HunkOwnerModel[];
}

export interface ChangelistModel {
  id: string;
  name: string;
  fileCount: number;
  hunkCount: number;
}

export interface RepoModel {
  repoRoot: string;
  headExists: boolean;
  files: FileModel[];
  changelists: ChangelistModel[];
  /** default（未分配）下的 hunk 总数 */
  unassignedHunkCount: number;
  /** default（未分配）下有改动的文件数（树视图 default 行与 changelist 行一致显示文件数） */
  unassignedFileCount: number;
}

/** 暂存状态（index 中 hunk 的占比）：全暂存 / 部分 / 未暂存 */
export type StageState = 'all' | 'partial' | 'none';

/**
 * 给定 hunk id 列表与暂存集合，判定暂存状态：
 * 空列表或集合为空 → none；全部命中 → all；其余 → partial。
 */
export function stageStateOf(
  ids: Iterable<string>,
  staged: ReadonlySet<string> | undefined,
): StageState {
  let hit = 0;
  let total = 0;
  if (staged) {
    for (const id of ids) {
      total++;
      if (staged.has(id)) {
        hit++;
      }
    }
  }
  if (total === 0 || hit === 0) {
    return 'none';
  }
  return hit === total ? 'all' : 'partial';
}

/** 跨文件/跨块聚合：空数组 → none；全 all → all；全 none → none；其余 → partial */
export function combineStageStates(states: readonly StageState[]): StageState {
  let all = true;
  let any = false;
  for (const s of states) {
    if (s === 'all') {
      any = true;
    } else {
      all = false;
    }
  }
  if (!any) {
    return 'none';
  }
  return all ? 'all' : 'partial';
}

export class ChangeDetector extends EventEmitter {
  private models = new Map<string, RepoModel>();
  /**
   * 已知仓库集合：normKey → { root, lazy }。root 保留 git rev-parse 原始输出
   * （store 的 repo key 形式，规范化后存储会让存量数据变孤儿）；lazy=true 表示
   * 经 resolveRepo 回退懒发现（扫描深度之外），靠「.git 存活 + 仍在 workspace 内」
   * 续命；lazy=false 表示 folder 解析/扫描发现，每轮 refreshAll 必须重新发现才存活。
   */
  private knownRepos = new Map<string, { root: string; lazy: boolean }>();
  /** folder realpath → 仓库 root（只缓存正结果：null 不缓存，git init 后新仓库下轮即可识别） */
  private folderRoots = new Map<string, string>();
  /** key: `${root}\u0000${path}\u0000${id}` → 连续未匹配次数 */
  private misses = new Map<string, number>();
  /**
   * 暂存缓存：repoRoot → 相对路径 → 已暂存 hunk id 集合（git diff --cached 解析产物）。
   * 只在 refreshRepo 时重算：保存文件不改变 index，外部 git 操作（add/reset/commit）
   * 会经 .git/index watcher 触发 refreshAll → refreshRepo。
   */
  private stagedByRoot = new Map<string, Map<string, Set<string>>>();
  /**
   * 刷新版本号（两套独立，互不作废）：
   * - allVersion：全量刷新（refreshAll）之间互作废。单文件刷新（保存 / watcher 防抖）
   *   不参与取号——否则点击刷新按钮期间任何文件保存都会把全量刷新作废，
   *   视图停留在旧状态（"点了刷新却没同步"）。
   * - fileVersions：按文件独立计数。多个文件同时变化（终端批量写入）各自刷新互不作废；
   *   同一文件高频变化只保留最后一次（与 extension 的 400ms 防抖互补）。
   * 每次刷新取号，结束时若自己不是最新号则丢弃结果（避免过期 diff 覆盖新模型，
   * 且 noteMatched 可能把旧 diff 里看不到的 hunk 误判 stale）。
   */
  private allVersion = 0;
  private fileVersions = new Map<string, number>();

  constructor(
    private git: GitService,
    private store: ChangelistStore,
    private getFolders: () => string[],
    /** 嵌套仓库扫描深度（changelistsPlus.repositoryScanMaxDepth）；getter 形式，配置即改即生效 */
    private getScanDepth: () => number = () => 1,
  ) {
    super();
  }

  /**
   * 文件系统路径 → 所属仓库 root（最深仓库优先）。
   * 两级解析：① 已知仓库集合最长前缀匹配（命中后再做祖先 .git 走查，发现
   * 深于扫描深度的嵌套仓库）；② 未命中且仍在 workspace 内 → 从路径自身向上
   * 找最近存在目录做 rev-parse（git 会向上走查到最近的仓库），发现的仓库
   * 懒加入集合。负结果不缓存（git init 后新仓库才能被识别）。
   */
  async resolveRepo(fsPath: string): Promise<string | null> {
    const p = path.normalize(realpathSafe(fsPath));
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    const hit = this.matchKnownRepo(key);
    if (hit) {
      return (await this.discoverBetween(hit.key, p)) ?? hit.root;
    }
    if (!this.insideAnyFolder(key)) {
      return null; // workspace 边界外不解析（与现状语义一致）
    }
    // 文件/目录可能已删除（删除场景）：spawn 的 cwd 必须存在。
    // p 自身是现存目录（folder 输入）时从 p 查起；是文件时 isDirectory 不成立走到父目录
    const dir = nearestExistingDir(p);
    if (!dir) {
      return null;
    }
    const root = await this.git.getRepoRoot(dir);
    if (root) {
      this.addKnownLazy(root);
    }
    return root;
  }

  /** 已知仓库中包含 key 的最长前缀项（嵌套时取最深仓库）；key 原样带出，调用方免重算 */
  private matchKnownRepo(key: string): { root: string; key: string } | null {
    let best: { root: string; key: string } | null = null;
    let bestLen = -1;
    for (const [k, e] of this.knownRepos) {
      if (k.length > bestLen && underOrEq(key, k)) {
        best = { root: e.root, key: k };
        bestLen = k.length;
      }
    }
    return best;
  }

  /**
   * 祖先 .git 走查：路径前缀命中已知仓库 hitKey 时，从路径自身逐级向上到该仓库，
   * 找更深层的嵌套仓库（含 .git 的目录）。没有它，folder 根是仓库 P 时
   * P/vendor/x/deep（深于扫描深度的仓库）里的文件前缀命中 P，嵌套仓库永远不可见。
   * 首个命中目录经 rev-parse 规范化：得到与 hitKey 不同的根 → 懒加入并返回；
   * rev-parse 失败（坏 .git，git 自身也止步于此）→ 中止走查，路由回 hitKey 命中项。
   * 纯 fs existsSync（µs 级），不做负缓存——git init 出嵌套仓库后保存其内文件即可被发现。
   */
  private async discoverBetween(hitKey: string, p: string): Promise<string | null> {
    // hitKey 是 map key（已 normalize+fold）；p 已是 normalize+realpath 形式，
    // 其祖先链同形式，只需折叠大小写比较——每层不再重复 realpathSync
    const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    // 从 p 自身查起：p 是文件时 p/.git 不可能存在（existsSync false）自然下移；
    // p 是现存目录（resolveRepo 的 folder 输入）时不错过其自身的 .git
    let dir = p;
    for (let i = 0; i < 20 && fold(dir).startsWith(hitKey + path.sep); i++) {
      if (looksLikeRepoRoot(dir)) {
        const root = await this.git.getRepoRoot(dir);
        if (!root) {
          return null; // 坏 .git：git 语义同样止步于此
        }
        if (normKey(root) !== hitKey) {
          this.addKnownLazy(root);
          return root;
        }
        return null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    return null;
  }

  /**
   * 懒发现加入已知仓库（扫描深度之外的仓库经 resolveRepo 回退发现）。
   * 仅当确实是新仓库时 emit('reposChanged')（extension 据此重连 git watcher）；
   * await 之后的同步 has 检查在 JS 单线程下天然去重，并发懒发现不会重复 emit。
   */
  private addKnownLazy(root: string): void {
    const key = normKey(root);
    if (this.knownRepos.has(key)) {
      return;
    }
    this.knownRepos.set(key, { root, lazy: true });
    this.emit('reposChanged');
  }

  /** key（normKey 形式）是否位于任一 workspace folder 内 */
  private insideAnyFolder(key: string): boolean {
    return this.getFolders().some((f) => underOrEq(key, normKey(f)));
  }

  /** 当前已知仓库根列表（git 原始输出形式），供 extension 按仓库装配 git watcher */
  repoRoots(): string[] {
    return [...this.knownRepos.values()].map((e) => e.root);
  }

  /**
   * 全量刷新：重建已知仓库集合（folder 解析 ∪ 嵌套扫描 ∪ 懒发现续命）后逐仓库刷新。
   * 集合 key 变化时 emit('reposChanged')（extension 据此重连 git watcher）——
   * 全等比较，每轮至多一次；stale 刷新不替换集合也不发事件。
   */
  async refreshAll(): Promise<void> {
    const v = ++this.allVersion;
    const stale = (): boolean => v !== this.allVersion;
    const next = new Map<string, { root: string; lazy: boolean }>();

    // A. folder 解析：folder 根的仓库（含 folder 是父仓库子目录的情形——rev-parse 向上走查）
    for (const folder of this.getFolders()) {
      const f = realpathSafe(folder);
      let root = this.folderRoots.get(f);
      // 存活校验：.git 被删后旧缓存会刷出死仓库的空模型
      if (root !== undefined && !looksLikeRepoRoot(root)) {
        this.folderRoots.delete(f);
        root = undefined;
      }
      if (root === undefined) {
        const found = await this.git.getRepoRoot(f);
        if (found !== null) {
          this.folderRoots.set(f, found);
          root = found;
        }
      }
      if (root) {
        next.set(normKey(root), { root, lazy: false });
      }
    }
    if (stale()) {
      return;
    }

    // B. 嵌套仓库扫描（深度可配。纯 fs readdir/existsSync，比 git 进程便宜几个
    // 数量级，故每轮都扫——换来「仓库被删 → 下轮自动消失」语义）
    const candidates = await scanForGitDirs(this.getFolders(), this.getScanDepth());
    if (stale()) {
      return;
    }
    for (const c of candidates) {
      const key = normKey(c);
      const existing = this.knownRepos.get(key);
      if (existing) {
        // 已知候选（含上轮懒发现）：沿用其 git 形式 root，不重复 rev-parse；提升为
        // 扫描发现。map 的 key 即该 root 的 normKey（插入时如此构造）——直接复用，
        // 省一次 realpathSync
        next.set(key, { root: existing.root, lazy: false });
        continue;
      }
      // 候选必须经 rev-parse 规范化：拿 git 的 realpath 规范根，与 store 既有 key 形式一致
      const root = await this.git.getRepoRoot(c);
      if (stale()) {
        return;
      }
      if (root) {
        next.set(normKey(root), { root, lazy: false });
      }
    }

    // C. 懒仓库续命：.git 存活且仍在当前 workspace 内（folder 移除后其下的懒仓库不再保留）
    for (const [key, e] of this.knownRepos) {
      if (!next.has(key) && e.lazy && looksLikeRepoRoot(e.root) && this.insideAnyFolder(key)) {
        next.set(key, e);
      }
    }

    // D. 集合替换（仅 key 集合变化才发事件——lazy 标志翻转不算）
    if (stale()) {
      return;
    }
    const changed =
      next.size !== this.knownRepos.size || [...next.keys()].some((k) => !this.knownRepos.has(k));
    this.knownRepos = next;
    if (changed) {
      this.emit('reposChanged');
    }

    // E. 逐仓库刷新（单文件刷新不参与作废——见 allVersion 注释）
    for (const { root } of next.values()) {
      if (stale()) {
        return;
      }
      await this.refreshRepo(root, v);
    }

    // F. 清理已移除仓库的模型与缓存。按 live knownRepos 判定（不是 next 快照）——
    // E 期间可能经 resolveRepo 懒加入新仓库，误清会让它们的模型闪没
    for (const key of [...this.models.keys()]) {
      if (!this.knownRepos.has(normKey(key))) {
        this.models.delete(key);
        this.stagedByRoot.delete(key);
      }
    }
    // misses 的 ${root}\0 前缀条目一并清（死仓库的 miss 记录否则会泄漏累积）。
    // 按 root 去重后判定：misses 条目数 ∝ 分配 hunk 数，逐条 normKey（内含
    // realpathSync syscall，死仓库路径还会走 throw 分支）会放大成每条一次 syscall
    const deadRoots = new Map<string, boolean>();
    for (const k of [...this.misses.keys()]) {
      const root = k.slice(0, k.indexOf('\u0000'));
      let dead = deadRoots.get(root);
      if (dead === undefined) {
        dead = !this.knownRepos.has(normKey(root));
        deadRoots.set(root, dead);
      }
      if (dead) {
        this.misses.delete(k);
      }
    }
    this.emit('change');
  }

  /**
   * 只重算 index 暂存状态（stage 命令尾部用）：stage 只改 index，worktree 内容、
   * hunk 归属都不变——树里唯一需要更新的是文件行圆点的暂存颜色。
   * 单进程 diffStaged（替代 refreshAll 的三路全量），toast 到树更新的间隔显著缩短。
   * 不参与 allVersion 作废：它是事实快照，refreshRepo 每次都会整块重算 stagedByRoot。
   */
  /**
   * 乐观暂存更新：stage 命令 apply 成功后，把本次实际应用的 hunk ids 立即并入
   * staged 缓存并 emit——树零等待变绿（不必等后台 diffStaged 校正）。
   * 只增不删：本批 ids 在 index 中必然存在（apply 已成功），并入总是正确；
   * 校正刷新（refreshStagedOnly / refreshRepo）是整块覆盖（含本批），
   * 两个方向的竞态都收敛到同一最终态。
   */
  mergeStagedIds(root: string, idsByPath: ReadonlyMap<string, ReadonlySet<string>>): void {
    if (!this.models.has(root) || idsByPath.size === 0) {
      return;
    }
    const staged = new Map(this.stagedByRoot.get(root) ?? []);
    let changed = false;
    for (const [p, ids] of idsByPath) {
      const next = new Set(staged.get(p));
      let any = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          any = true;
        }
      }
      if (any) {
        staged.set(p, next);
        changed = true;
      }
    }
    if (changed) {
      this.stagedByRoot.set(root, staged);
      this.emit('change');
    }
  }

  async refreshStagedOnly(root: string): Promise<void> {
    if (!this.models.has(root)) {
      return;
    }
    const staged = new Map<string, Set<string>>();
    for (const fc of parseGitDiff(await this.git.diffStaged(root))) {
      staged.set(fc.path, new Set(fc.hunks.map((h) => h.id)));
    }
    this.stagedByRoot.set(root, staged);
    this.emit('change');
  }

  /** 单文件定向刷新（保存 / 外部修改后触发） */
  async refreshFile(fsPath: string): Promise<void> {
    // per-file 版本号：不同文件的刷新互不作废（终端批量写入的多个文件都要同步）；
    // 同一文件高频变化只保留最后一次。key 在刷新完成时删除，map 无长期增长
    const key = realpathSafe(fsPath);
    const v = (this.fileVersions.get(key) ?? 0) + 1;
    this.fileVersions.set(key, v);
    const root = await this.resolveRepo(fsPath);
    if (!root) {
      return;
    }
    // 与 resolveRepo 同样的归一：root 是 git 的 realpath，fsPath 必须也是
    // realpath，path.relative 才算得出仓库内相对路径
    const p = realpathSafe(fsPath);
    const rel = path.relative(root, p).split(path.sep).join('/');
    const stale = (): boolean => this.fileVersions.get(key) !== v;
    if (stale()) {
      return;
    }
    if (!this.models.has(root)) {
      // 模型尚未初始化：全量兜底。不传 token——refreshFile 已按文件版本号校验，
      // 且 refreshRepo 的 token 语义是 allVersion，传 per-file 号会误作废
      await this.refreshRepo(root);
      return;
    }
    const untracked = await this.git.isUntracked(root, rel);
    if (stale()) {
      return;
    }
    if (untracked) {
      this.upsertFile(root, rel, this.buildUntrackedModel(root, rel));
    } else {
      const changes = parseGitDiff(await this.git.diffFile(root, rel));
      if (stale()) {
        return;
      }
      const fc = changes.find((c) => c.path === rel);
      this.upsertFile(root, rel, fc ? this.buildModelForChange(root, fc) : null);
    }
    this.fileVersions.delete(key);
    this.emit('change');
  }

  private async refreshRepo(root: string, token?: number): Promise<void> {
    // headExists 也并入并行：原实现串行 await 多等一个进程往返（低配机明显）
    const [diffText, untracked, stagedText, headExists] = await Promise.all([
      this.git.diffWorktree(root),
      this.git.untrackedFiles(root),
      this.git.diffStaged(root),
      this.git.headExists(root),
    ]);
    if (token !== undefined && token !== this.allVersion) {
      return; // 过期全量刷新：丢弃，避免旧 diff 覆盖新模型（refreshFile 不传 token）
    }
    // 暂存缓存：diff --cached 与 diffWorktree 同 flags 同解析器，路径/换行体系一致，
    // hunk id 为内容哈希，直接与视图模型 hunk 匹配（staged 后工作区再编辑 → id 变 → 自然失配）
    const staged = new Map<string, Set<string>>();
    for (const fc of parseGitDiff(stagedText)) {
      staged.set(fc.path, new Set(fc.hunks.map((h) => h.id)));
    }
    this.stagedByRoot.set(root, staged);
    const files: FileModel[] = [];
    for (const fc of parseGitDiff(diffText)) {
      files.push(this.buildModelForChange(root, fc));
    }
    for (const rel of untracked) {
      // 嵌套仓库目录的占位条目（git 对其不下钻，实测 -z 输出恒为正斜杠 `nested/`——
      // 任何平台都以 '/' 结尾，勿用 path.sep）：嵌套仓库独立成组，内容不属于本仓库
      if (rel.endsWith('/')) {
        continue;
      }
      if (files.some((f) => f.change.path === rel)) {
        continue;
      }
      const m = this.buildUntrackedModel(root, rel);
      if (m) {
        files.push(m);
      }
    }
    files.sort((a, b) => a.change.path.localeCompare(b.change.path));
    this.models.set(root, {
      repoRoot: root,
      headExists,
      files,
      changelists: [],
      unassignedHunkCount: 0,
      unassignedFileCount: 0,
    });
    this.computeCounts(root);
  }

  private buildModelForChange(root: string, fc: FileChange): FileModel {
    const withOwner = this.store.recordsWithOwner(root, fc.path);
    const { owners, updates } = matchFileHunks(fc.hunks, withOwner.map((w) => w.record));
    this.store.updatePositions(
      root,
      updates.map((u) => ({ path: fc.path, ...u })),
    );
    const ownerOf = new Map(withOwner.map((w) => [w.record.id, w.ownerId]));
    const hunks = fc.hunks.map((h, i) => {
      const rec = owners[i];
      return { hunk: h, ownerId: rec ? ownerOf.get(rec.id) ?? null : null };
    });
    this.noteMatched(root, fc.path, owners);
    return { change: fc, hunks };
  }

  private buildUntrackedModel(root: string, rel: string): FileModel | null {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(path.join(root, rel));
    } catch {
      return null; // 文件在扫描间隙被删除
    }
    if (isBinaryContent(buf)) {
      return {
        change: { path: rel, kind: 'new', binary: true, headerLines: [], hunks: [] },
        hunks: [],
      };
    }
    return this.buildModelForChange(root, makeUntrackedChange(rel, buf.toString('utf8')));
  }

  /**
   * stale 清理：本次匹配不上的记录记一次 miss，连续两次 miss 才删除。
   * 顺带把已消失（如刚被回滚）的 hunk 记入下一周期。
   */
  private noteMatched(root: string, filePath: string, owners: (StoredHunk | null)[]): void {
    const matched = new Set(owners.filter(Boolean).map((s) => (s as StoredHunk).id));
    for (const w of this.store.recordsWithOwner(root, filePath)) {
      const key = `${root}\u0000${filePath}\u0000${w.record.id}`;
      if (matched.has(w.record.id)) {
        this.misses.delete(key);
      } else {
        const n = (this.misses.get(key) ?? 0) + 1;
        if (n >= 2) {
          this.misses.delete(key);
          this.store.removeRecords(root, filePath, [w.record.id]);
        } else {
          this.misses.set(key, n);
        }
      }
    }
  }

  private upsertFile(root: string, rel: string, fileModel: FileModel | null): void {
    const model = this.models.get(root);
    if (!model) {
      return;
    }
    if (!fileModel) {
      model.files = model.files.filter((f) => f.change.path !== rel);
    } else {
      const idx = model.files.findIndex((f) => f.change.path === rel);
      if (idx >= 0) {
        model.files[idx] = fileModel;
      } else {
        model.files.push(fileModel);
        model.files.sort((a, b) => a.change.path.localeCompare(b.change.path));
      }
    }
    this.computeCounts(root);
  }

  private computeCounts(root: string): void {
    const model = this.models.get(root);
    if (!model) {
      return;
    }
    const byCl = new Map<string, { files: Set<string>; hunks: number }>();
    let unassigned = 0;
    const unassignedFiles = new Set<string>();
    for (const f of model.files) {
      for (const h of f.hunks) {
        if (h.ownerId) {
          let e = byCl.get(h.ownerId);
          if (!e) {
            e = { files: new Set(), hunks: 0 };
            byCl.set(h.ownerId, e);
          }
          e.files.add(f.change.path);
          e.hunks++;
        } else {
          unassigned++;
          unassignedFiles.add(f.change.path);
        }
      }
    }
    model.changelists = this.store.changelistsOf(root).map((c) => {
      const e = byCl.get(c.id);
      return { id: c.id, name: c.name, fileCount: e?.files.size ?? 0, hunkCount: e?.hunks ?? 0 };
    });
    model.unassignedHunkCount = unassigned;
    model.unassignedFileCount = unassignedFiles.size;
  }

  getModel(root: string): RepoModel | undefined {
    return this.models.get(root);
  }

  /** 某文件已暂存的 hunk id 集合（index 中 vs HEAD 的改动）；未刷新或无暂存 → undefined */
  stagedIds(root: string, relPath: string): ReadonlySet<string> | undefined {
    return this.stagedByRoot.get(root)?.get(relPath);
  }

  snapshot(): RepoModel[] {
    return [...this.models.values()];
  }
}
