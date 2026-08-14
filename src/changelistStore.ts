/**
 * Changelist 数据模型与持久化。
 * - 数据结构按 repo root（toplevel 路径）分 key，多根/多仓库天然兼容
 * - 持久化到 workspaceStorage 下的 changelists.json，原子写（临时文件 + rename）
 * - 解析失败（损坏）时把坏文件改名 .corrupt-<ts> 备份后从空状态启动
 * - 通过 EventEmitter 的 'change' 事件通知结构性变更（增删改分配），
 *   位置回写（updatePositions）不触发事件，避免刷新循环
 * - 不依赖 vscode，可在 node 环境直接测试
 */
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StoredHunk } from './matching';

export interface Changelist {
  id: string;
  name: string;
  /** key: 仓库相对路径（/ 分隔）→ 该文件在此 changelist 中的 hunk 记录 */
  hunks: Record<string, StoredHunk[]>;
}

export interface RepoData {
  changelists: Changelist[];
}

interface StorageFile {
  version: number;
  repos: Record<string, RepoData>;
}

export interface HunkWithOwner {
  record: StoredHunk;
  ownerId: string | null;
}

export interface PositionUpdate {
  path: string;
  id: string;
  oldStart: number;
  oldLines: number;
}

export class ChangelistStore extends EventEmitter {
  private data: StorageFile = { version: 1, repos: {} };
  private filePath: string;
  private pendingSave = false;
  /** 启动时的加载告警（如损坏备份路径），由扩展层 toast */
  readonly warnings: string[] = [];

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as StorageFile;
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.version === 1 &&
        parsed.repos &&
        typeof parsed.repos === 'object'
      ) {
        this.data = parsed;
      } else {
        throw new Error('invalid storage format');
      }
    } catch {
      const backup = this.filePath + '.corrupt-' + Date.now();
      try {
        fs.renameSync(this.filePath, backup);
        this.warnings.push(backup);
      } catch {
        /* 备份失败则忽略，从空状态启动 */
      }
      this.data = { version: 1, repos: {} };
    }
  }

  /** 原子写：同目录临时文件 + rename（setImmediate 去重合并连续写入） */
  private save(): void {
    if (this.pendingSave) {
      return;
    }
    this.pendingSave = true;
    setImmediate(() => {
      this.pendingSave = false;
      try {
        const tmp = this.filePath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filePath);
      } catch {
        /* 磁盘异常时保持内存态，下次写入重试 */
      }
    });
  }

  /** 同步落盘（测试用；绕过 setImmediate 防抖，保证断言前已持久化） */
  flush(): void {
    try {
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch {
      /* 与 save() 相同：失败保持内存态 */
    }
  }

  private repo(repoRoot: string): RepoData {
    let d = this.data.repos[repoRoot];
    if (!d) {
      d = { changelists: [] };
      this.data.repos[repoRoot] = d;
    }
    return d;
  }

  changelistsOf(repoRoot: string): Changelist[] {
    return this.repo(repoRoot).changelists;
  }

  createChangelist(repoRoot: string, name: string): Changelist {
    const cl: Changelist = { id: randomUUID(), name, hunks: {} };
    this.repo(repoRoot).changelists.push(cl);
    this.emitChange();
    this.save();
    return cl;
  }

  renameChangelist(repoRoot: string, id: string, name: string): boolean {
    const cl = this.find(repoRoot, id);
    if (!cl) {
      return false;
    }
    cl.name = name;
    this.emitChange();
    this.save();
    return true;
  }

  /** 删除 changelist：其下 hunk 记录一并删除，即自动回到"未分配" */
  deleteChangelist(repoRoot: string, id: string): boolean {
    const list = this.repo(repoRoot).changelists;
    const idx = list.findIndex((c) => c.id === id);
    if (idx < 0) {
      return false;
    }
    list.splice(idx, 1);
    this.emitChange();
    this.save();
    return true;
  }

  private find(repoRoot: string, id: string): Changelist | undefined {
    return this.repo(repoRoot).changelists.find((c) => c.id === id);
  }

  /** 某文件在所有 changelist 中的记录（跨 changelist 去重，附所属 changelist id） */
  recordsWithOwner(repoRoot: string, filePath: string): HunkWithOwner[] {
    const out: HunkWithOwner[] = [];
    const seen = new Set<string>();
    for (const cl of this.repo(repoRoot).changelists) {
      for (const rec of cl.hunks[filePath] ?? []) {
        if (!seen.has(rec.id)) {
          seen.add(rec.id);
          out.push({ record: rec, ownerId: cl.id });
        }
      }
    }
    return out;
  }

  /**
   * 分配/移动：将 records 设为目标 changelist（null = 未分配）。
   * 先从事先所有 changelist 中移除这些 id，再并入目标（同 id 覆盖位置）。
   */
  setHunkOwners(
    repoRoot: string,
    filePath: string,
    records: StoredHunk[],
    targetId: string | null,
  ): void {
    const ids = new Set(records.map((r) => r.id));
    for (const cl of this.repo(repoRoot).changelists) {
      if (cl.id === targetId) {
        // 目标 changelist：合并（同 id 覆盖位置）；该文件首次分配时 arr 不存在
        const arr = cl.hunks[filePath] ?? [];
        for (const rec of records) {
          const idx = arr.findIndex((x) => x.id === rec.id);
          if (idx >= 0) {
            arr[idx] = rec;
          } else {
            arr.push(rec);
          }
        }
        cl.hunks[filePath] = arr;
      } else {
        const arr = cl.hunks[filePath];
        if (!arr) {
          continue;
        }
        cl.hunks[filePath] = arr.filter((r) => !ids.has(r.id));
        if (cl.hunks[filePath].length === 0) {
          delete cl.hunks[filePath];
        }
      }
    }
    this.emitChange();
    this.save();
  }

  /** 直接移除记录（stale 清理用）。不触发 change 事件——调用方随后会刷新。 */
  removeRecords(repoRoot: string, filePath: string, ids: string[]): void {
    const idSet = new Set(ids);
    for (const cl of this.repo(repoRoot).changelists) {
      const arr = cl.hunks[filePath];
      if (!arr) {
        continue;
      }
      cl.hunks[filePath] = arr.filter((r) => !idSet.has(r.id));
      if (cl.hunks[filePath].length === 0) {
        delete cl.hunks[filePath];
      }
    }
    this.save();
  }

  /** 匹配成功后回写记录位置（跟随当前 hunk 的最新 oldStart），不触发 change 事件 */
  updatePositions(repoRoot: string, updates: PositionUpdate[]): void {
    if (!updates.length) {
      return;
    }
    for (const u of updates) {
      for (const cl of this.repo(repoRoot).changelists) {
        const arr = cl.hunks[u.path];
        if (!arr) {
          continue;
        }
        const rec = arr.find((x) => x.id === u.id);
        if (rec) {
          rec.oldStart = u.oldStart;
          rec.oldLines = u.oldLines;
          break;
        }
      }
    }
    this.save();
  }

  private emitChange(): void {
    this.emit('change');
  }
}
