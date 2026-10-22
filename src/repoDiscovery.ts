/**
 * 嵌套 git 仓库发现（纯 fs，无 vscode 依赖，node 测试可直用）。
 * 对齐 VS Code 内置 git 扩展的仓库扫描行为：workspace folder 内按深度
 * 扫描子目录，含 `.git`（目录 = 普通仓库；文件 = linked worktree /
 * submodule 指针）的目录即候选仓库根。
 *
 * 注意：返回的是文件系统候选路径，不做规范化（realpath / git 形式）——
 * 规范化（rev-parse --show-toplevel）由调用方（ChangeDetector）统一做，
 * 保证与 store 既有数据的 repo key 形式一致。
 */
import * as fs from 'fs';
import * as path from 'path';

/** 默认跳过的目录名：.git 内部不扫；node_modules 体量大且几乎不会是仓库根 */
const DEFAULT_SKIP: ReadonlySet<string> = new Set(['.git', 'node_modules']);

/**
 * dir 是否像一个仓库根：`.git` 存在（目录或指针文件均可，existsSync 两者兼容）。
 * 也用于已知仓库的存活校验（.git 被删 → 仓库不再存在）。
 */
export function looksLikeRepoRoot(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

/**
 * BFS 扫描 folders 的直接/间接子目录，返回含 `.git` 的目录列表。
 *
 * 深度语义对齐 VS Code 的 git.repositoryScanMaxDepth：
 * - folder 自身为 depth 0（不在扫描范围——folder 自身是否仓库由 rev-parse 解析，
 *   还能覆盖「folder 是父仓库子目录」的情形）
 * - 直接子目录为 depth 1；maxDepth=1 时只检查直接子目录，不递归
 * - maxDepth <= 0 直接返回空
 *
 * symlink 目录（含 Windows junction，Dirent.isSymbolicLink() 同样成立）只作
 * 候选检查、不下钻——防止扫出 workspace 外或符号链接成环。
 * 每层 frontier 的 readdir 并行；深度受限（配置上限 10），层数 ≤ maxDepth。
 */
export async function scanForGitDirs(
  folders: string[],
  maxDepth: number,
  skip: ReadonlySet<string> = DEFAULT_SKIP,
): Promise<string[]> {
  if (maxDepth <= 0) {
    return [];
  }
  const found: string[] = [];
  let frontier = folders.filter((f) => {
    try {
      return fs.statSync(f).isDirectory();
    } catch {
      return false; // folder 不存在/不可读
    }
  });
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    await Promise.all(
      frontier.map(async (dir) => {
        let entries: fs.Dirent[];
        try {
          entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          return; // 无权限/被并发删除
        }
        for (const e of entries) {
          if (!(e.isDirectory() || e.isSymbolicLink()) || skip.has(e.name)) {
            continue;
          }
          const child = path.join(dir, e.name);
          if (looksLikeRepoRoot(child)) {
            found.push(child);
          }
          // 发现的仓库也继续下钻（深度预算内）：嵌套仓库/submodule 在更深
          // 层级时同样能被发现（对齐 VS Code 扫描行为——只按深度计，不在
          // 仓库边界停步）；vendor 等深层仓库由 maxDepth 预算兜底
          if (depth < maxDepth) {
            next.push(child);
          }
        }
      }),
    );
    frontier = next;
  }
  return found;
}
