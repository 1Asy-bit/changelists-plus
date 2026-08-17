/**
 * unified diff 解析/序列化。
 * 设计要点：
 * - 只解析 `git diff` 的输出格式（--no-renames，core.quotepath=false 下路径原样输出）
 * - hunk 正文按原样保留（含 `\ No newline at end of file` 标记），序列化时逐行还原，
 *   保证"解析→过滤→再 apply"完全忠实于 git 输出
 * - 二进制文件：git 输出 `Binary files ... differ`，无 hunks，标记 binary 后不参与拆分
 */
import { createHash } from 'crypto';

export interface Hunk {
  /** 稳定身份：sha256(路径 + 删除行 + 新增行)，行内容先剥 \r 归一 EOL */
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 原始 @@ 头，如 "@@ -12,4 +13,5 @@" */
  header: string;
  /** 原始 hunk 主体行（含 ' ' '+' '-' '\\' 前缀），用于忠实重建 patch */
  bodyLines: string[];
  /** 仅 + 行内容（不含前缀，已剥 \r） */
  added: string[];
  /** 仅 - 行内容（不含前缀，已剥 \r） */
  removed: string[];
  /** 首行改动预览（保留 +/- 前缀，截断） */
  preview: string;
}

export type FileKind = 'modified' | 'new' | 'deleted';

export interface FileChange {
  /** 仓库相对路径（/ 分隔，未引用转义） */
  path: string;
  kind: FileKind;
  binary: boolean;
  /** 文件头原始行：diff --git / index / mode / --- / +++ 等，序列化时原样还原 */
  headerLines: string[];
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
/** 路径与 ± 行之间的分隔符（内容中不会出现的控制字符） */
const SEP = '\u0000';

export function hunkId(filePath: string, removed: string[], added: string[]): string {
  const norm = (lines: string[]) => lines.map((l) => l.replace(/\r$/, '')).join('\n');
  return createHash('sha256')
    .update(filePath)
    .update(SEP)
    .update(norm(removed))
    .update(SEP)
    .update(norm(added))
    .digest('hex');
}

export function parseGitDiff(text: string): FileChange[] {
  const files: FileChange[] = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('diff --git ')) {
      const parsed = parseFileChange(lines, i);
      files.push(parsed.change);
      i = parsed.next;
    } else {
      i++;
    }
  }
  return files;
}

function parseFileChange(lines: string[], start: number): { change: FileChange; next: number } {
  const headerLines: string[] = [];
  let i = start;
  let binary = false;
  let newFileMode = false;
  let deletedFileMode = false;
  let oldPath: string | undefined;
  let newPath: string | undefined;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('@@')) {
      break;
    }
    if (line.startsWith('diff --git ') && i > start) {
      break;
    }
    headerLines.push(line);
    if (line.startsWith('Binary files ')) {
      binary = true;
    }
    if (line.startsWith('new file mode ')) {
      newFileMode = true;
    }
    if (line.startsWith('deleted file mode ')) {
      deletedFileMode = true;
    }
    if (line.startsWith('--- /dev/null')) {
      oldPath = '';
    } else if (line.startsWith('--- ')) {
      // 路径含空格时 git 会在行尾追加 TAB 标记（未加引号），需剥掉
      oldPath = line.slice(4).replace(/^a\//, '').replace(/\t$/, '');
    }
    if (line.startsWith('+++ /dev/null')) {
      newPath = '';
    } else if (line.startsWith('+++ ')) {
      newPath = line.slice(4).replace(/^b\//, '').replace(/\t$/, '');
    }
  }

  const kind: FileKind = newFileMode || oldPath === ''
    ? 'new'
    : deletedFileMode || newPath === ''
      ? 'deleted'
      : 'modified';
  let filePath = newPath !== undefined && newPath !== '' ? newPath : oldPath ?? '';
  if (!filePath) {
    // 二进制文件的 diff 没有 ---/+++ 行（只有 "Binary files ... differ"），
    // 从 diff --git 行提取路径
    const gitLine = headerLines.find((l) => l.startsWith('diff --git '));
    if (gitLine) {
      const rest = gitLine.slice('diff --git '.length);
      filePath = rest.split(' b/')[0].replace(/^a\//, '');
    }
  }

  const hunks: Hunk[] = [];
  while (i < lines.length && !lines[i].startsWith('diff --git ')) {
    const m = HUNK_RE.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    i++;
    const bodyLines: string[] = [];
    while (i < lines.length) {
      const ch = lines[i][0];
      if (ch === ' ' || ch === '+' || ch === '-' || ch === '\\') {
        bodyLines.push(lines[i]);
        i++;
      } else {
        break;
      }
    }
    hunks.push(makeHunk(filePath, bodyLines, m));
  }

  return { change: { path: filePath, kind, binary, headerLines, hunks }, next: i };
}

function makeHunk(
  filePath: string,
  bodyLines: string[],
  m: RegExpExecArray,
): Hunk {
  const oldStart = Number(m[1]);
  const oldLines = m[2] ? Number(m[2]) : 1;
  const newStart = Number(m[3]);
  const newLines = m[4] ? Number(m[4]) : 1;
  // git 原始 hunk 头（如 `@@ -2 +2 @@ l1`）可能带 func context 后缀。
  // -U0 下 hunk 无上下文行，该后缀会被 git apply 当作定位线索导致错位
  // （实验验证：带后缀的无上下文 patch 无法 apply）。统一重建为规范头：
  // 显式逗号计数、不带后缀——只有这种头能可靠应用，且计数与内容一致。
  const header = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`;
  const added: string[] = [];
  const removed: string[] = [];
  for (const l of bodyLines) {
    if (l[0] === '+') {
      added.push(l.slice(1));
    } else if (l[0] === '-') {
      removed.push(l.slice(1));
    }
  }
  const previewLine = bodyLines.find((l) => l[0] === '+' || l[0] === '-');
  const preview = previewLine ? previewLine.slice(0, 81) : '';
  return {
    id: hunkId(filePath, removed, added),
    oldStart,
    oldLines,
    newStart,
    newLines,
    header,
    bodyLines,
    added,
    removed,
    preview,
  };
}

/** 将（可能被过滤过的）FileChange 列表重建为可交给 git apply 的 patch 文本 */
export function serializePatch(files: FileChange[]): string {
  const parts: string[] = [];
  for (const fc of files) {
    parts.push(...fc.headerLines);
    for (const h of fc.hunks) {
      parts.push(h.header, ...h.bodyLines);
    }
  }
  return parts.length ? parts.join('\n') + '\n' : '';
}

/**
 * 为未跟踪文件合成 FileChange：整个文件内容作为单个 hunk（isNew）。
 * git diff 不输出未跟踪文件，需要自行读取内容构造。
 */
export function makeUntrackedChange(relPath: string, content: string): FileChange {
  let lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  const newLines = lines.length;
  const header = newLines > 0 ? `@@ -0,0 +1,${newLines} @@` : '@@ -0,0 +0,0 @@';
  const hunk: Hunk = {
    id: hunkId(relPath, [], lines),
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines,
    header,
    bodyLines: lines.map((l) => '+' + l),
    added: lines,
    removed: [],
    preview: lines[0] ? '+' + lines[0].slice(0, 80) : '',
  };
  return {
    path: relPath,
    kind: 'new',
    binary: false,
    headerLines: [
      `diff --git a/${relPath} b/${relPath}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${relPath}`,
    ],
    hunks: [hunk],
  };
}

/** 粗略二进制检测：内容开头 8KB 内含 NUL 字节即视为二进制 */
export function isBinaryContent(buf: Buffer): boolean {
  return buf.slice(0, 8192).includes(0);
}

/**
 * hunk 是否命中编辑器选区 [a, b]（1-based 行号，new 侧坐标）。
 * - new 侧相交：改动的新行区间（新增/替换行所在位置）
 * - old 侧相交：删除行区间（纯删除块 newLines=0 时 new 侧为空，靠这里命中；
 *   删除行在编辑器里不可见，用同一 [a,b] 近似删除缺口的位置）
 * - 命中即整块分配（最小分配单元是块，不做块内子拆分）
 */
export function hunkHitsSelection(hunk: Hunk, a: number, b: number): boolean {
  if (hunk.newLines > 0) {
    const hs = hunk.newStart;
    const he = hunk.newStart + hunk.newLines - 1;
    if (hs <= b && he >= a) {
      return true;
    }
  }
  if (hunk.oldLines > 0) {
    const os = hunk.oldStart;
    const oe = hunk.oldStart + hunk.oldLines - 1;
    return os <= b && oe >= a;
  }
  return false;
}
