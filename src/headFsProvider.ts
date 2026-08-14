/**
 * 只读 FileSystemProvider：为 diff 视图提供仓库内文件的 HEAD 版本内容。
 * URI 形如 changelistsplus-head:///<worktree 绝对路径>，
 * query 携带 { root, rel }，readFile 时用 `git show HEAD:<rel>` 取原始字节。
 * 未跟踪文件 / HEAD 中不存在 → 返回空内容（diff 左侧为空，与 git 语义一致）。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { GitService } from './gitService';

export const HEAD_SCHEME = 'changelistsplus-head';

export function createHeadUri(repoRoot: string, relPath: string): vscode.Uri {
  return vscode.Uri.file(path.join(repoRoot, relPath)).with({
    scheme: HEAD_SCHEME,
    query: encodeURIComponent(JSON.stringify({ root: repoRoot, rel: relPath })),
  });
}

export class HeadFileSystemProvider implements vscode.FileSystemProvider {
  private readonly _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._emitter.event;

  constructor(private git: GitService) {}

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { root, rel } = JSON.parse(decodeURIComponent(uri.query)) as {
      root: string;
      rel: string;
    };
    const buf = await this.git.headFileContent(root, rel);
    return buf ?? new Uint8Array();
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: 0 };
  }

  readDirectory(): [] {
    return [];
  }

  createDirectory(): never {
    throw vscode.FileSystemError.NoPermissions('readonly');
  }

  writeFile(): never {
    throw vscode.FileSystemError.NoPermissions('readonly');
  }

  delete(): never {
    throw vscode.FileSystemError.NoPermissions('readonly');
  }

  rename(): never {
    throw vscode.FileSystemError.NoPermissions('readonly');
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }
}
