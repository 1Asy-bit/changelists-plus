/**
 * git CLI 封装。所有 git 操作都经由本模块，便于在测试中替换。
 * 该模块不依赖 vscode，可在 node 环境下直接测试。
 */
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 仓库根路径 → 定长短哈希（临时目录名；真实路径含 / 不能作目录名） */
function hashRepoRoot(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
}

/**
 * pathspec magic：把路径按字面处理，文件名里的 * ? [ 不再当 glob。
 * git diff 不支持 --literal-pathspecs 选项，但两处（diff/ls-files）都支持 `:(literal)` 前缀。
 */
function literalPathspec(relPath: string): string {
  return ':(literal)' + relPath;
}

/** 大仓库 diff 输出可能远超默认缓冲，需显式设置上限。 */
const MAX_OUTPUT = 256 * 1024 * 1024;

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunOptions {
  cwd?: string;
  /** 写入 stdin 的内容（用于 git apply 等从 stdin 读 patch 的命令） */
  input?: string;
  env?: NodeJS.ProcessEnv;
}

export class GitService {
  private contextLines: number;

  constructor(private gitPath: string, contextLines = 3) {
    this.contextLines = contextLines;
  }

  updateContextLines(n: number): void {
    this.contextLines = n;
  }

  run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    return this.runRaw(args, opts).then((r) => ({
      code: r.code,
      stdout: r.stdout.toString('utf8'),
      stderr: r.stderr,
    }));
  }

  /** 原始字节版本（git show 可能输出非 UTF-8 内容，diff 视图需要原样字节） */
  private runRaw(
    args: string[],
    opts: GitRunOptions = {},
  ): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.gitPath, args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => {
        chunks.push(d);
        size += d.length;
        if (size > MAX_OUTPUT) {
          child.kill();
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        stderr += d;
      });
      child.on('error', (err) => resolve({ code: -1, stdout: Buffer.concat(chunks), stderr: String(err) }));
      child.on('close', (code) =>
        resolve({ code: code === null ? -1 : code, stdout: Buffer.concat(chunks), stderr }),
      );
      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    });
  }

  async getRepoRoot(cwd: string): Promise<string | null> {
    const r = await this.run(['rev-parse', '--show-toplevel'], { cwd });
    if (r.code !== 0) {
      return null;
    }
    const root = r.stdout.trim();
    return root || null;
  }

  async headExists(repoRoot: string): Promise<boolean> {
    const r = await this.run(['rev-parse', '-q', '--verify', 'HEAD'], { cwd: repoRoot });
    return r.code === 0;
  }

  /**
   * 统一的 diff flags：
   * - core.quotepath=false：中文/空格路径原样输出，免去 C 风格转义解析
   * - --no-ext-diff：不调用外部 diff 工具
   * - --no-renames：重命名退化为 delete+add，与拆分模型自洽
   * - --ignore-submodules=all：子模块不产生可拆分 hunk
   */
  private diffFlags(): string[] {
    return [
      '-c', 'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      `-U${this.contextLines}`,
      '--no-renames',
      '--ignore-submodules=all',
    ];
  }

  /** worktree vs HEAD 全量 diff */
  async diffWorktree(repoRoot: string): Promise<string> {
    const r = await this.run([...this.diffFlags(), 'HEAD', '--'], { cwd: repoRoot });
    return r.code === 0 ? r.stdout : '';
  }

  /** index vs HEAD（已有 staged 状态快照） */
  async diffStaged(repoRoot: string): Promise<string> {
    const r = await this.run([...this.diffFlags(), '--cached'], { cwd: repoRoot });
    return r.code === 0 ? r.stdout : '';
  }

  /**
   * 单个文件的 worktree vs HEAD diff。
   * 文件名含 * ? [ 时会被当作 pathspec glob 匹配多个文件 → 误判；
   * 用 `:(literal)` magic 前缀按字面路径处理（git diff 不支持 --literal-pathspecs）。
   */
  async diffFile(repoRoot: string, relPath: string): Promise<string> {
    const r = await this.run([...this.diffFlags(), 'HEAD', '--', literalPathspec(relPath)], {
      cwd: repoRoot,
    });
    return r.code === 0 ? r.stdout : '';
  }

  /**
   * HEAD 中某个文件的原始内容（diff 视图左侧）。
   * 未跟踪文件/HEAD 中不存在 → null（diff 左侧显示为空）。
   */
  async headFileContent(repoRoot: string, relPath: string): Promise<Buffer | null> {
    const r = await this.runRaw(['show', `HEAD:${relPath}`], { cwd: repoRoot });
    return r.code === 0 ? r.stdout : null;
  }

  /**
   * 把基于 HEAD 基线的 patch 应用到一个临时文件（HEAD 内容 + patch），
   * 供「只看该 changelist 修改」的 diff 视图作为右侧内容。
   * 用 git apply 保证 CRLF/换行处理与 git 一致；返回临时文件路径，失败 → null。
   */
  async applyPatchToTempFile(repoRoot: string, relPath: string, patch: string): Promise<string | null> {
    // 按仓库区分临时目录：多仓库工作区里不同仓库的同名文件会互相覆盖
    const dir = path.join(os.tmpdir(), 'changelists-plus-synth', hashRepoRoot(repoRoot));
    const file = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const head = await this.headFileContent(repoRoot, relPath);
    if (head) {
      fs.writeFileSync(file, head);
    } else {
      // 未跟踪文件：patch 是 new file mode，目标文件不能预先存在
      fs.rmSync(file, { force: true });
    }
    const r = await this.run(['apply', '--whitespace=nowarn'], { cwd: dir, input: patch });
    if (r.code !== 0) {
      return null;
    }
    return file;
  }

  /** 未跟踪文件列表（仓库相对路径，/ 分隔） */
  async untrackedFiles(repoRoot: string): Promise<string[]> {
    const r = await this.run(['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repoRoot });
    if (r.code !== 0) {
      return [];
    }
    return r.stdout.split('\0').filter((p) => p.length > 0);
  }

  /** 判断某个仓库相对路径是否未跟踪（文件名含 * ? [ 时按字面处理，见 literalPathspec） */
  async isUntracked(repoRoot: string, relPath: string): Promise<boolean> {
    const r = await this.run(
      ['ls-files', '--others', '--exclude-standard', '--', literalPathspec(relPath)],
      { cwd: repoRoot },
    );
    return r.code === 0 && r.stdout.trim() === relPath;
  }

  /** 仓库是否存在未合并（冲突）路径 */
  async hasUnmerged(repoRoot: string): Promise<boolean> {
    const r = await this.run(['ls-files', '-u'], { cwd: repoRoot });
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /**
   * 检查 git 目录中的状态文件/目录是否存在（merge/rebase/cherry-pick 等）。
   * 用 `git rev-parse --git-path` 解析路径，对 linked worktree 也正确。
   */
  async guardPathExists(repoRoot: string, name: string): Promise<boolean> {
    const r = await this.run(['rev-parse', '--git-path', name], { cwd: repoRoot });
    if (r.code !== 0 || !r.stdout.trim()) {
      return false;
    }
    const p = r.stdout.trim();
    const abs = path.isAbsolute(p) ? p : path.join(repoRoot, p);
    return fs.existsSync(abs);
  }
}
