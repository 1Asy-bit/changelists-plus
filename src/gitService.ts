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

/** 视图标识（'unassigned' / changelist id）→ 定长短哈希（临时子目录名） */
function hashVariant(variant: string): string {
  return createHash('sha256').update(variant).digest('hex').slice(0, 8);
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

/**
 * 合成 diff 临时目录根：/tmp/changelists-plus-synth/<repo 哈希>/...
 * 这些文件只服务于打开的 diff 视图，可随时删除——再次点击文件会重新合成。
 * 配套清理：视图关闭即删、deactivate 清残留、启动时 TTL 清扫（见 sweepSynthDir）。
 */
const SYNTH_ROOT = path.join(os.tmpdir(), 'changelists-plus-synth');

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
  constructor(private gitPath: string) {}

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
   * - -U0：零上下文——任何非相邻的改动（间隔 ≥1 行）都独立成 hunk（块），
   *   可分别分配到不同 changelist（块级拆分）。git 会把间隔 < 2×contextLines
   *   的改动合并，只有 -U0 能保证"不同行的改动"各自独立。
   * - --no-renames：重命名退化为 delete+add，与拆分模型自洽
   * - --ignore-submodules=all：子模块不产生可拆分 hunk
   */
  private diffFlags(): string[] {
    return [
      '-c', 'core.quotepath=false',
      'diff',
      '--no-ext-diff',
      '-U0',
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
   *
   * variant = 视图标识（'unassigned' 或 changelist id）：
   * 同一文件在多个视图下可**同时打开多个 diff 标签页**——若所有视图共用同一个
   * 临时文件，(left, right) URI 对相同，VS Code 只会激活已有标签页，且后开的
   * 视图会覆盖先开的文件内容。按 (仓库, 视图) 分目录后各自独立；
   * 再次打开同一视图同一文件则复用同一路径，VS Code 激活既有标签页（不重复开）。
   */
  async applyPatchToTempFile(
    repoRoot: string,
    relPath: string,
    patch: string,
    variant: string,
  ): Promise<string | null> {
    // 按仓库 + 视图区分临时目录：多仓库同名文件、同文件多视图互不覆盖
    const dir = path.join(SYNTH_ROOT, hashRepoRoot(repoRoot), hashVariant(variant));
    const file = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const head = await this.headFileContent(repoRoot, relPath);
    if (head) {
      fs.writeFileSync(file, head);
    } else {
      // 未跟踪文件：patch 是 new file mode，目标文件不能预先存在
      fs.rmSync(file, { force: true });
    }
    // --unidiff-zero：内部 diff 为 -U0，patch 无上下文行，git apply 默认拒绝（见 commitEngine 注释）
    const r = await this.run(['apply', '--unidiff-zero', '--whitespace=nowarn'], { cwd: dir, input: patch });
    if (r.code !== 0) {
      return null;
    }
    return file;
  }

  /**
   * 启动清扫：删除早于 maxAgeMs 的合成临时文件（崩溃/强退/未关闭 diff 的残留）。
   * 按仓库哈希目录整体判断：目录内**最新文件**的 mtime 过期才删整个目录
   * （目录 mtime 不随文件内容变化更新，stat 目录会永远判定为"新"）。
   * 目录不存在时静默返回。
   */
  sweepSynthDir(maxAgeMs: number): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(SYNTH_ROOT, { withFileTypes: true });
    } catch {
      return; // 目录不存在，无残留
    }
    const now = Date.now();
    for (const e of entries) {
      const p = path.join(SYNTH_ROOT, e.name);
      if (!e.isDirectory()) {
        continue;
      }
      let newest = -Infinity;
      const walk = (d: string): void => {
        let items: fs.Dirent[];
        try {
          items = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const it of items) {
          const fp = path.join(d, it.name);
          if (it.isDirectory()) {
            walk(fp);
          } else {
            try {
              newest = Math.max(newest, fs.statSync(fp).mtimeMs);
            } catch {
              /* 文件被并发清理，忽略 */
            }
          }
        }
      };
      walk(p);
      // 目录内无文件（newest < 0）不处理：可能是并发正在合成的目录
      if (newest >= 0 && now - newest > maxAgeMs) {
        try {
          fs.rmSync(p, { recursive: true, force: true });
        } catch {
          /* 删除失败忽略，下次清扫再试 */
        }
      }
    }
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
