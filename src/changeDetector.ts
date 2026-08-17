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

/** 归一符号链接（macOS /tmp、/var 等）；文件已不存在时保持原路径 */
function realpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
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
  unassignedHunkCount: number;
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
  private folderRoots = new Map<string, string | null>();
  /** key: `${root}\u0000${path}\u0000${id}` → 连续未匹配次数 */
  private misses = new Map<string, number>();
  /**
   * 暂存缓存：repoRoot → 相对路径 → 已暂存 hunk id 集合（git diff --cached 解析产物）。
   * 只在 refreshRepo 时重算：保存文件不改变 index，外部 git 操作（add/reset/commit）
   * 会经 .git/index watcher 触发 refreshAll → refreshRepo。
   */
  private stagedByRoot = new Map<string, Map<string, Set<string>>>();

  constructor(
    private git: GitService,
    private store: ChangelistStore,
    private getFolders: () => string[],
  ) {
    super();
  }

  /** 文件系统路径 → 所属仓库 root（经 workspace folder 缓存解析） */
  async resolveRepo(fsPath: string): Promise<string | null> {
    // macOS 上 /tmp、/var 等是符号链接：VS Code 的 fsPath 是用户视角路径，
    // 而 git 返回 realpath（/private/…）。不归一的话前缀匹配与 path.relative 都会错。
    // Windows 上文件系统大小写不敏感：盘符/目录大小写差异会导致前缀匹配失败，
    // 比较前统一转小写（path.relative 内部已按大小写不敏感比较 drive，无需处理）。
    const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    const p = realpathSafe(fsPath);
    const folders = this.getFolders().map((f) => realpathSafe(f));
    const folder = folders
      .filter((f) => fold(p) === fold(f) || fold(p).startsWith(fold(f) + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (!folder) {
      return null;
    }
    let root = this.folderRoots.get(folder);
    if (root === undefined) {
      root = await this.git.getRepoRoot(folder);
      this.folderRoots.set(folder, root);
    }
    return root;
  }

  async refreshAll(): Promise<void> {
    const roots = new Set<string>();
    for (const folder of this.getFolders()) {
      const r = await this.git.getRepoRoot(folder);
      if (r) {
        roots.add(r);
      }
    }
    for (const root of roots) {
      await this.refreshRepo(root);
    }
    for (const key of [...this.models.keys()]) {
      if (!roots.has(key)) {
        this.models.delete(key);
        this.stagedByRoot.delete(key);
      }
    }
    this.emit('change');
  }

  /** 单文件定向刷新（保存后触发） */
  async refreshFile(fsPath: string): Promise<void> {
    const root = await this.resolveRepo(fsPath);
    if (!root) {
      return;
    }
    // 与 resolveRepo 同样的归一：root 是 git 的 realpath，fsPath 必须也是
    // realpath，path.relative 才算得出仓库内相对路径
    const p = realpathSafe(fsPath);
    const rel = path.relative(root, p).split(path.sep).join('/');
    if (!this.models.has(root)) {
      await this.refreshRepo(root);
      return;
    }
    const untracked = await this.git.isUntracked(root, rel);
    if (untracked) {
      this.upsertFile(root, rel, this.buildUntrackedModel(root, rel));
    } else {
      const changes = parseGitDiff(await this.git.diffFile(root, rel));
      const fc = changes.find((c) => c.path === rel);
      this.upsertFile(root, rel, fc ? this.buildModelForChange(root, fc) : null);
    }
    this.emit('change');
  }

  private async refreshRepo(root: string): Promise<void> {
    const [diffText, untracked, stagedText] = await Promise.all([
      this.git.diffWorktree(root),
      this.git.untrackedFiles(root),
      this.git.diffStaged(root),
    ]);
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
      if (files.some((f) => f.change.path === rel)) {
        continue;
      }
      const m = this.buildUntrackedModel(root, rel);
      if (m) {
        files.push(m);
      }
    }
    files.sort((a, b) => a.change.path.localeCompare(b.change.path));
    const headExists = await this.git.headExists(root);
    this.models.set(root, {
      repoRoot: root,
      headExists,
      files,
      changelists: [],
      unassignedHunkCount: 0,
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
        }
      }
    }
    model.changelists = this.store.changelistsOf(root).map((c) => {
      const e = byCl.get(c.id);
      return { id: c.id, name: c.name, fileCount: e?.files.size ?? 0, hunkCount: e?.hunks ?? 0 };
    });
    model.unassignedHunkCount = unassigned;
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
