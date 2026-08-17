/**
 * 零依赖测试脚手架：node 内置 assert，测试运行时在临时目录 git init 真实仓库。
 * 运行：npm test（tsc && node dist/test/run.js）
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService } from '../gitService';
import { ChangelistStore } from '../changelistStore';
import {
  Hunk,
  hunkId,
  hunkHitsSelection,
  isBinaryContent,
  makeUntrackedChange,
  parseGitDiff,
  serializePatch,
} from '../diffParser';
import { matchFileHunks, StoredHunk } from '../matching';
import {
  buildFilePatch,
  buildUnassignedPatch,
  commitChangelist,
  commitUnassigned,
  discardChangelist,
  discardUnassigned,
  discardViewChanges,
  stageChangelist,
  stageRecords,
  stageUnassigned,
} from '../commitEngine';
import { ChangeDetector, combineStageStates, stageStateOf } from '../changeDetector';

const GIT = 'git';

function git(dir: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync(GIT, args, {
    cwd: dir,
    input: input ?? undefined,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : undefined,
  });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-test-'));
  git(dir, ['init', '-b', 'main', '-q']);
  git(dir, ['config', 'user.email', 't@test']);
  git(dir, ['config', 'user.name', 'Tester']);
  return dir;
}

function writeFile(dir: string, rel: string, content: string): void {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function readFile(dir: string, rel: string): string {
  return fs.readFileSync(path.join(dir, rel), 'utf8');
}

function commitAll(dir: string, msg: string): void {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', msg, '-q']);
}

function newEngine(dir: string) {
  const gitSvc = new GitService(GIT);
  // store 必须放在仓库目录外：在仓库内会成为 untracked 文件，被 ls-files --others
  // 合成进 freshDiff，污染「未分配」视图（default 批量操作会把 store 文件一起提交/暂存）
  const store = new ChangelistStore(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-')), 'store.json'),
  );
  return { gitSvc, store };
}

/**
 * 两 hunk 场景：f.txt 修改 line2（A）与 line11（B），A 已分配给 changelist。
 * 内部 diff 固定 -U0，间隔 ≥1 行的改动各自独立成 hunk（块级拆分）。
 */
async function setupTwoHunkScenario() {
  const dir = makeRepo();
  writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n');
  commitAll(dir, 'init');
  writeFile(dir, 'f.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\n');
  const { gitSvc, store } = newEngine(dir);
  const cl = store.createChangelist(dir, 'Feature A');
  const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
  assert.strictEqual(fc.hunks.length, 2, 'expected two separate hunks');
  const hunkA = fc.hunks[0];
  const hunkB = fc.hunks[1];
  store.setHunkOwners(
    dir,
    'f.txt',
    [{ id: hunkA.id, oldStart: hunkA.oldStart, oldLines: hunkA.oldLines }],
    cl.id,
  );
  return { dir, gitSvc, store, cl, hunkA, hunkB };
}

/** 构造完整 Hunk（matching 单测用） */
function makeHunk(
  rel: string,
  removed: string[],
  added: string[],
  oldStart: number,
  oldLines = removed.length,
): Hunk {
  return {
    id: hunkId(rel, removed, added),
    oldStart,
    oldLines,
    newStart: oldStart,
    newLines: added.length,
    header: `@@ -${oldStart} +${oldStart} @@`,
    bodyLines: [],
    added,
    removed,
    preview: added[0] ? '+' + added[0] : '',
  };
}

// ---- 测试收集（顺序执行） ----
let passed = 0;
const failures: string[] = [];
const tests: Array<{ name: string; fn: () => Promise<void> | void }> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push({ name, fn });
}

// ================= parser =================

test('parser: 单文件两处修改解析为两个 hunk', () => {
  const dir = makeRepo();
  try {
    // -U0 下间隔 ≥1 行（中间有未改动行）的两处改动各自独立成块
    writeFile(dir, 'a.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\n');
    commitAll(dir, 'init');
    writeFile(dir, 'a.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nB1\nl11\n');
    const text = git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', 'HEAD', '--']);
    const files = parseGitDiff(text);
    assert.strictEqual(files.length, 1);
    const fc = files[0];
    assert.strictEqual(fc.path, 'a.txt');
    assert.strictEqual(fc.kind, 'modified');
    assert.strictEqual(fc.hunks.length, 2);
    assert.notStrictEqual(fc.hunks[0].id, fc.hunks[1].id);
    assert.ok(fc.hunks[0].header.startsWith('@@ '));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: 新文件/删除文件/二进制', () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'b.txt', 'x\n');
    commitAll(dir, 'init');
    writeFile(dir, 'new.txt', 'n1\nn2\n');
    fs.rmSync(path.join(dir, 'b.txt'));
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]));
    // git diff 不显示未跟踪文件：先把它们加进 index（diff HEAD 仍按 HEAD 为基线）
    git(dir, ['add', '-A']);
    const text = git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', 'HEAD', '--']);
    const files = parseGitDiff(text);
    assert.strictEqual(files.length, 3);
    const newFc = files.find((f) => f.path === 'new.txt')!;
    assert.strictEqual(newFc.kind, 'new');
    assert.strictEqual(newFc.hunks.length, 1);
    assert.strictEqual(newFc.hunks[0].added.length, 2);
    const delFc = files.find((f) => f.path === 'b.txt')!;
    assert.strictEqual(delFc.kind, 'deleted');
    assert.strictEqual(delFc.hunks.length, 1);
    assert.strictEqual(delFc.hunks[0].removed.length, 1);
    const binFc = files.find((f) => f.path === 'bin.dat')!;
    assert.ok(binFc.binary);
    assert.strictEqual(binFc.hunks.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: 无结尾换行（\\ No newline）标记保留并可重建', () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'e.txt', 'aaa\nbbb');
    commitAll(dir, 'init');
    writeFile(dir, 'e.txt', 'aaa\nBBB');
    const text = git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', 'HEAD', '--']);
    const files = parseGitDiff(text);
    assert.strictEqual(files.length, 1);
    assert.ok(files[0].hunks[0].bodyLines.some((l) => l.startsWith('\\')));
    const patch = serializePatch(files);
    git(dir, ['read-tree', 'HEAD']);
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'], patch);
    const staged = git(dir, ['diff', '--cached']);
    assert.ok(staged.includes('\\ No newline at end of file'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: 中文/空格路径原样解析并可 apply', () => {
  const dir = makeRepo();
  try {
    writeFile(dir, '空间 目录/中文 文件.txt', 'v1\n');
    commitAll(dir, 'init');
    writeFile(dir, '空间 目录/中文 文件.txt', 'v2\n');
    const text = git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', 'HEAD', '--']);
    const files = parseGitDiff(text);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].path, '空间 目录/中文 文件.txt');
    const patch = serializePatch(files);
    git(dir, ['read-tree', 'HEAD']);
    git(dir, ['apply', '--cached', '--unidiff-zero'], patch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: CRLF 仓库（autocrlf=true）diff/apply 自洽', () => {
  const dir = makeRepo();
  try {
    git(dir, ['config', 'core.autocrlf', 'true']);
    writeFile(dir, 'crlf.txt', 'a\r\nb\r\nc\r\n');
    commitAll(dir, 'init');
    writeFile(dir, 'crlf.txt', 'a\r\nB\r\nc\r\n');
    const text = git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', 'HEAD', '--']);
    const files = parseGitDiff(text);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0].hunks.length, 1);
    const patch = serializePatch(files);
    git(dir, ['read-tree', 'HEAD']);
    git(dir, ['apply', '--cached', '--unidiff-zero'], patch);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: 未跟踪文件合成 + 二进制检测', () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'base.txt', 'x\n');
    commitAll(dir, 'init');
    writeFile(dir, 'u.txt', 'u1\nu2\n');
    const fc = makeUntrackedChange('u.txt', readFile(dir, 'u.txt'));
    assert.strictEqual(fc.kind, 'new');
    assert.strictEqual(fc.hunks.length, 1);
    assert.strictEqual(fc.hunks[0].newStart, 1);
    assert.strictEqual(fc.hunks[0].newLines, 2);
    assert.ok(isBinaryContent(Buffer.from([1, 0, 2])));
    assert.ok(!isBinaryContent(Buffer.from('hello')));
    // 空文件
    const empty = makeUntrackedChange('empty.txt', '');
    assert.strictEqual(empty.hunks[0].newLines, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= matching =================

test('matching: 内容哈希匹配与上下文/位置无关', () => {
  const rel = 'f.ts';
  const cur = [makeHunk(rel, ['x'], ['y'], 10)];
  const stored: StoredHunk[] = [{ id: cur[0].id, oldStart: 3, oldLines: 1 }];
  const r = matchFileHunks(cur, stored);
  assert.strictEqual(r.owners[0], stored[0]);
});

test('matching: 同哈希碰撞按位置最近消解', () => {
  const rel = 'f.ts';
  const cur = [makeHunk(rel, ['x'], ['y'], 10), makeHunk(rel, ['x'], ['y'], 60)];
  const stored: StoredHunk[] = [
    { id: cur[0].id, oldStart: 12, oldLines: 1 },
    { id: cur[1].id, oldStart: 58, oldLines: 1 },
  ];
  const r = matchFileHunks(cur, stored);
  assert.strictEqual(r.owners[0], stored[0]);
  assert.strictEqual(r.owners[1], stored[1]);
});

test('matching: 位置回退（窗口内重叠≥50%）并回写位置', () => {
  const rel = 'f.ts';
  const cur = [makeHunk(rel, ['a1', 'a2', 'a3', 'a4', 'a5'], ['b1', 'b2', 'b3', 'b4', 'b5'], 12)];
  const stored: StoredHunk[] = [{ id: 'stale-id', oldStart: 10, oldLines: 5 }];
  const r = matchFileHunks(cur, stored);
  assert.strictEqual(r.owners[0], stored[0]);
  assert.deepStrictEqual(r.updates, [{ id: 'stale-id', oldStart: 12, oldLines: 5 }]);
});

test('matching: 窗口外/歧义不硬配', () => {
  const rel = 'f.ts';
  const cur = [makeHunk(rel, ['a1', 'a2', 'a3', 'a4', 'a5'], ['b1', 'b2', 'b3', 'b4', 'b5'], 12)];
  const far: StoredHunk[] = [{ id: 'far', oldStart: 200, oldLines: 5 }];
  assert.strictEqual(matchFileHunks(cur, far).owners[0], null);
  const ambiguous: StoredHunk[] = [
    { id: 's1', oldStart: 11, oldLines: 5 },
    { id: 's2', oldStart: 13, oldLines: 5 },
  ];
  assert.strictEqual(matchFileHunks(cur, ambiguous).owners[0], null);
});

// ================= store =================

test('store: 分配/移动/删除/持久化/损坏恢复', () => {
  const dir = makeRepo();
  try {
    const storage = path.join(dir, 'store.json');
    const store = new ChangelistStore(storage);
    const cl1 = store.createChangelist(dir, 'Feature A');
    const cl2 = store.createChangelist(dir, 'Bugfix');
    const recs: StoredHunk[] = [
      { id: 'h1', oldStart: 1, oldLines: 2 },
      { id: 'h2', oldStart: 5, oldLines: 1 },
    ];
    store.setHunkOwners(dir, 'a.ts', recs, cl1.id);
    assert.strictEqual(store.recordsWithOwner(dir, 'a.ts').length, 2);

    store.setHunkOwners(dir, 'a.ts', [recs[0]], cl2.id);
    const owners = store.recordsWithOwner(dir, 'a.ts');
    assert.strictEqual(owners.find((w) => w.record.id === 'h1')!.ownerId, cl2.id);
    assert.strictEqual(owners.find((w) => w.record.id === 'h2')!.ownerId, cl1.id);

    store.flush();
    const store2 = new ChangelistStore(storage);
    assert.strictEqual(store2.changelistsOf(dir).length, 2);
    assert.strictEqual(
      store2.recordsWithOwner(dir, 'a.ts').find((w) => w.record.id === 'h1')!.ownerId,
      cl2.id,
    );

    store2.deleteChangelist(dir, cl2.id);
    store2.flush();
    const after = store2.recordsWithOwner(dir, 'a.ts');
    assert.strictEqual(after.find((w) => w.record.id === 'h1'), undefined);

    fs.writeFileSync(storage, '{broken json');
    const store3 = new ChangelistStore(storage);
    assert.strictEqual(store3.warnings.length, 1);
    assert.strictEqual(store3.changelistsOf(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= engine =================

// 回归：VS Code 不保证 context.storageUri 目录已存在（workspaceStorage 下扩展目录
// 不会自动创建）。父目录缺失时保存必须能建目录并落盘——否则 changelist 退出即丢。
test('store: 父目录不存在时也能持久化（模拟 context.storageUri）', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-'));
  try {
    // 故意不创建父目录，直接指向深层路径
    const storage = path.join(base, 'not-yet-created', 'nested', 'changelists.json');
    const store = new ChangelistStore(storage);
    const cl = store.createChangelist('/fake/repo', 'Persistent CL');
    store.setHunkOwners('/fake/repo', 'a.ts', [{ id: 'h1', oldStart: 1, oldLines: 2 }], cl.id);
    // save() 是 setImmediate 防抖，这里同步 flush 验证 ensureDir 路径（deactivate 也走它）
    store.flush();
    assert.ok(fs.existsSync(storage), 'flush 后文件应存在（父目录被自动创建）');

    // 重新加载（模拟下次打开 VS Code）→ changelist 与分配都还在
    const store2 = new ChangelistStore(storage);
    const cl2 = store2.changelistsOf('/fake/repo');
    assert.strictEqual(cl2.length, 1);
    assert.strictEqual(cl2[0].name, 'Persistent CL');
    assert.strictEqual(store2.recordsWithOwner('/fake/repo', 'a.ts').length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('engine: 纯净提交——只提交 A，B 保留，worktree 逐字节不变', async () => {
  const { dir, gitSvc, store, cl, hunkB } = await setupTwoHunkScenario();
  try {
    const before = readFile(dir, 'f.txt');
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'feat: A',
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(git(dir, ['log', '-1', '--format=%s']).trim(), 'feat: A');
    const after = parseGitDiff(await gitSvc.diffWorktree(dir));
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].hunks.length, 1);
    assert.strictEqual(after[0].hunks[0].id, hunkB.id);
    assert.strictEqual(readFile(dir, 'f.txt'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 整文件 staged 时提交 A——staged 恢复为只剩 B', async () => {
  const { dir, gitSvc, store, cl, hunkB } = await setupTwoHunkScenario();
  try {
    git(dir, ['add', 'f.txt']);
    assert.ok((await gitSvc.diffStaged(dir)).length > 0);
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'feat: A',
    });
    assert.ok(r.ok, JSON.stringify(r));
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1);
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, hunkB.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: add -p 部分 staged（只 stage B）后提交 A——B 保持 staged', async () => {
  const { dir, gitSvc, store, cl, hunkB } = await setupTwoHunkScenario();
  try {
    const full = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    const bOnly = serializePatch([{ ...full, hunks: [hunkB] }]);
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'], bOnly);
    const stagedBefore = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(stagedBefore.length, 1);
    assert.strictEqual(stagedBefore[0].hunks[0].id, hunkB.id);

    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'feat: A',
    });
    assert.ok(r.ok, JSON.stringify(r));
    const stagedAfter = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(stagedAfter.length, 1);
    assert.strictEqual(stagedAfter[0].hunks[0].id, hunkB.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 未跟踪新文件提交——进入 HEAD，worktree 不变，status 干净', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'base.txt', 'ok\n');
    commitAll(dir, 'init');
    writeFile(dir, 'newfile.txt', 'n1\nn2\nn3\n');
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'New File CL');
    const untracked = (await gitSvc.untrackedFiles(dir)).filter((f) => f !== '.store.json');
    assert.deepStrictEqual(untracked, ['newfile.txt']);
    const fc = makeUntrackedChange('newfile.txt', readFile(dir, 'newfile.txt'));
    store.setHunkOwners(
      dir,
      'newfile.txt',
      [{ id: fc.hunks[0].id, oldStart: 0, oldLines: 0 }],
      cl.id,
    );

    const before = readFile(dir, 'newfile.txt');
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'add newfile',
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(git(dir, ['ls-files']).split('\n').includes('newfile.txt'));
    assert.strictEqual(readFile(dir, 'newfile.txt'), before);
    const status = git(dir, ['status', '--porcelain']);
    assert.ok(!status.includes('newfile.txt'), 'newfile should be clean, got: ' + status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 删除文件提交', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'gone.txt', 'g1\ng2\n');
    commitAll(dir, 'init');
    fs.rmSync(path.join(dir, 'gone.txt'));
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'Delete CL');
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.kind, 'deleted');
    store.setHunkOwners(
      dir,
      'gone.txt',
      [{ id: fc.hunks[0].id, oldStart: fc.hunks[0].oldStart, oldLines: fc.hunks[0].oldLines }],
      cl.id,
    );
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'delete gone',
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.throws(() => git(dir, ['cat-file', '-e', 'HEAD:gone.txt']));
    const status = git(dir, ['status', '--porcelain']);
    assert.ok(!status.includes('gone.txt'), 'gone should be clean, got: ' + status);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: pre-commit hook 失败——HEAD 与真实 index 零损伤', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    git(dir, ['add', 'f.txt']);
    const headBefore = git(dir, ['rev-parse', 'HEAD']).trim();
    const stagedBefore = await gitSvc.diffStaged(dir);
    writeFile(dir, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(dir, '.git/hooks/pre-commit'), 0o755);
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'should fail',
    });
    assert.ok(!r.ok);
    assert.strictEqual(r.error, 'commitFailed');
    assert.strictEqual(git(dir, ['rev-parse', 'HEAD']).trim(), headBefore);
    assert.strictEqual(await gitSvc.diffStaged(dir), stagedBefore);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 守卫——merge 进行中 / unborn HEAD / 空 changelist / 空消息', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'a.txt', 'x\n');
    commitAll(dir, 'init');
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'CL');
    writeFile(dir, 'a.txt', 'y\n');
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    store.setHunkOwners(
      dir,
      'a.txt',
      [{ id: fc.hunks[0].id, oldStart: fc.hunks[0].oldStart, oldLines: fc.hunks[0].oldLines }],
      cl.id,
    );

    fs.writeFileSync(path.join(dir, '.git', 'MERGE_HEAD'), 'deadbeef\n');
    let r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'm',
    });
    assert.ok(!r.ok);
    assert.strictEqual(r.error, 'mergeInProgress');
    fs.rmSync(path.join(dir, '.git', 'MERGE_HEAD'));

    const empty = makeRepo();
    try {
      const { gitSvc: g2, store: s2 } = newEngine(empty);
      const cl2 = s2.createChangelist(empty, 'CL');
      r = await commitChangelist({
        git: g2,
        store: s2,
        repoRoot: empty,
        changelistId: cl2.id,
        message: 'm',
      });
      assert.ok(!r.ok);
      assert.strictEqual(r.error, 'noHead');
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }

    const emptyCl = store.createChangelist(dir, 'Empty');
    r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: emptyCl.id,
      message: 'm',
    });
    assert.ok(!r.ok);
    assert.strictEqual(r.error, 'empty');

    r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: '   ',
    });
    assert.ok(!r.ok);
    assert.strictEqual(r.error, 'emptyMessage');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 冲突文件存在时拒绝提交', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'c.txt', 'base\n');
    commitAll(dir, 'init');
    git(dir, ['checkout', '-b', 'other', '-q']);
    writeFile(dir, 'c.txt', 'other\n');
    commitAll(dir, 'other');
    git(dir, ['checkout', 'main', '-q']);
    writeFile(dir, 'c.txt', 'main\n');
    git(dir, ['add', 'c.txt']);
    git(dir, ['commit', '-m', 'main-version', '-q']);
    try {
      git(dir, ['merge', 'other']);
    } catch {
      /* 预期冲突 */
    }
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'CL');
    writeFile(dir, 'c.txt', 'modified\n');
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'm',
    });
    assert.ok(!r.ok);
    // merge 进行中也会被 MERGE_HEAD 守卫先拦住，两者其一即可
    assert.ok(r.error === 'unmerged' || r.error === 'mergeInProgress');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: restore 兜底阶梯——staged 快照与已提交内容冲突时 reset + 告警', async () => {
  // 场景：stage 整文件（A1 入 index）→ 又改 worktree 同区域（A2，紧邻行也改了）。
  // 提交 changelist（fresh 匹配到 A2）后，restore = A1 快照：
  //  ① 原样 apply：-U0 无上下文，line2 已是 A2 → 内容不匹配 → 失败
  //  ② --3way：ours(HEAD+A2) 与 theirs(A1) 都改了 line2 → 冲突 → 失败
  //  ③ --recount：位置/内容都不对 → 失败 → ④ reset + warning
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n');
    commitAll(dir, 'init');
    writeFile(dir, 'f.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\n');
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'CL');
    const fc0 = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc0.hunks.length, 1);
    store.setHunkOwners(
      dir,
      'f.txt',
      [{ id: fc0.hunks[0].id, oldStart: fc0.hunks[0].oldStart, oldLines: fc0.hunks[0].oldLines }],
      cl.id,
    );
    git(dir, ['add', 'f.txt']); // A1 入 index
    // worktree 再改：line2 A1→A2 且 line3 也改（fresh hunk 变成 oldLines=2，位置回退匹配 A1 记录）
    writeFile(dir, 'f.txt', 'l1\nA2\nA3\nl4\nl5\nl6\nl7\nl8\n');

    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'feat: A',
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.warning, 'restoreFailed');
    // 兜底：index 清空（丢 staged 状态），worktree 内容从未被动
    assert.strictEqual(await gitSvc.diffStaged(dir), '');
    assert.strictEqual(readFile(dir, 'f.txt'), 'l1\nA2\nA3\nl4\nl5\nl6\nl7\nl8\n');
    // 提交的是最新的 A2 内容
    assert.strictEqual(git(dir, ['show', 'HEAD:f.txt']), 'l1\nA2\nA3\nl4\nl5\nl6\nl7\nl8\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= stage（暂存） =================

test('engine: 暂存 changelist——index 只含目标 hunks，worktree 逐字节不变', async () => {
  const { dir, gitSvc, store, cl, hunkA, hunkB } = await setupTwoHunkScenario();
  try {
    const before = readFile(dir, 'f.txt');
    const r = await stageChangelist({ git: gitSvc, store, repoRoot: dir, changelistId: cl.id });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.ok && r.stagedCount === 1);
    // index 只含 A
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1);
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, hunkA.id);
    // worktree 逐字节不变
    assert.strictEqual(readFile(dir, 'f.txt'), before);
    // B 仍在 unstaged：部分暂存的文件 status 显示为 MM（index 列 + worktree 列）
    const lines = git(dir, ['status', '--short']).trim().split('\n');
    assert.ok(lines.includes('MM f.txt'), lines.join('\n'));
    const unstaged = parseGitDiff(await gitSvc.diffWorktree(dir));
    assert.strictEqual(unstaged[0].hunks.length, 2);
    assert.ok(unstaged[0].hunks.some((h) => h.id === hunkB.id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 暂存后提交该 changelist——提交自洽，index 对齐新 HEAD', async () => {
  const { dir, gitSvc, store, cl, hunkB } = await setupTwoHunkScenario();
  try {
    const s = await stageChangelist({ git: gitSvc, store, repoRoot: dir, changelistId: cl.id });
    assert.ok(s.ok, JSON.stringify(s));
    const c = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'feat: A',
    });
    assert.ok(c.ok, JSON.stringify(c));
    // A 已进入 HEAD，B 仍在 worktree（未提交）
    assert.strictEqual(
      git(dir, ['show', 'HEAD:f.txt']),
      'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n',
    );
    // staged 的内容随提交消失：index 与 HEAD' 一致
    assert.strictEqual(await gitSvc.diffStaged(dir), '');
    // worktree 只剩 B
    const after = parseGitDiff(await gitSvc.diffWorktree(dir));
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].hunks.length, 1);
    assert.strictEqual(after[0].hunks[0].id, hunkB.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 暂存指定记录（stageRecords）——只暂存选中的 hunk', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n');
    commitAll(dir, 'init');
    writeFile(dir, 'f.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\n');
    const { gitSvc, store } = newEngine(dir);
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    const hunkA = fc.hunks[0];
    // 不分配，直接按记录暂存 hunk A
    const r = await stageRecords(
      gitSvc,
      dir,
      new Map([['f.txt', [{ id: hunkA.id, oldStart: hunkA.oldStart, oldLines: hunkA.oldLines }]]]),
    );
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.ok && r.stagedCount === 1);
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1);
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, hunkA.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: stage 守卫——unborn HEAD 拒绝', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'x\n');
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'C');
    const r = await stageChangelist({ git: gitSvc, store, repoRoot: dir, changelistId: cl.id });
    assert.ok(!r.ok);
    assert.strictEqual(r.ok ? '' : r.error, 'noHead');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 视图 diff 合成内容 =================

test('diff 视图：CL-A 下的文件合成内容只含 CL-A 的修改，不含 B', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    // CL-A 的 patch → 合成临时文件 = HEAD + 仅 A
    const patch = await buildFilePatch(gitSvc, store, dir, 'f.txt', (o) => o === cl.id);
    assert.ok(patch);
    const tmp = await gitSvc.applyPatchToTempFile(dir, 'f.txt', patch!.patch, cl.id);
    assert.ok(tmp);
    const synth = fs.readFileSync(tmp!, 'utf8');
    // HEAD + A：line2 是 A1，line11 仍是原始 l11（B 不出现）
    assert.strictEqual(
      synth,
      'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n',
    );
    // 与 worktree 对比：worktree 里 line11 是 B1（B 的修改不在合成内容里）
    assert.notStrictEqual(synth, readFile(dir, 'f.txt'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diff 视图：Unassigned 下的文件合成内容只含未分配的修改', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    // 未分配的 patch（B）→ 合成 = HEAD + 仅 B
    const patch = await buildFilePatch(gitSvc, store, dir, 'f.txt', (o) => o === null);
    assert.ok(patch);
    const tmp = await gitSvc.applyPatchToTempFile(dir, 'f.txt', patch!.patch, 'unassigned');
    assert.ok(tmp);
    assert.strictEqual(
      fs.readFileSync(tmp!, 'utf8'),
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\n',
    );
    // CL-A 的合成不包含 B；两者的合成拼起来 = worktree
    const patchA = await buildFilePatch(gitSvc, store, dir, 'f.txt', (o) => o === cl.id);
    assert.ok(patchA);
    const tmpA = await gitSvc.applyPatchToTempFile(dir, 'f.txt', patchA!.patch, cl.id);
    assert.ok(tmpA);
    const synthA = fs.readFileSync(tmpA!, 'utf8');
    // 两处修改分别合成后，合并内容（A 位置取 A1，B 位置取 B1）应等于 worktree
    assert.strictEqual(synthA, 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('diff 视图：未跟踪文件合成 = 文件内容（HEAD 为空基线）', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'v1\n');
    commitAll(dir, 'init');
    writeFile(dir, 'new.txt', 'n1\nn2\n');
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'CL');
    // 新文件作为整体 hunk 分配进 CL（git diff HEAD 不含 untracked，用 makeUntrackedChange 合成）
    const fc = makeUntrackedChange('new.txt', 'n1\nn2\n');
    store.setHunkOwners(
      dir,
      'new.txt',
      fc.hunks.map((h) => ({ id: h.id, oldStart: h.oldStart, oldLines: h.oldLines })),
      cl.id,
    );
    const patch = await buildFilePatch(gitSvc, store, dir, 'new.txt', (o) => o === cl.id);
    assert.ok(patch);
    const tmp = await gitSvc.applyPatchToTempFile(dir, 'new.txt', patch!.patch, cl.id);
    assert.ok(tmp);
    assert.strictEqual(fs.readFileSync(tmp!, 'utf8'), 'n1\nn2\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 按视图撤销（discard） =================

test('discard：撤销 CL 视图的修改，只移除该视图的 hunks，未分配的保留', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    const r = await discardViewChanges(gitSvc, store, dir, 'f.txt', cl.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.ok && r.count, 1);
    // 剩余 diff = 只有 B（未分配）
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.hunks.length, 1);
    assert.strictEqual(fc.hunks[0].added[0], 'B1');
    // 工作区内容 = HEAD + B
    assert.strictEqual(
      readFile(dir, 'f.txt'),
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\n',
    );
    // CL 的记录已清理（B 未分配本无记录）
    assert.strictEqual(store.recordsWithOwner(dir, 'f.txt').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discard：撤销整个 changelist 的修改，未分配的 hunks 保留', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    const r = await discardChangelist(gitSvc, store, dir, cl.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.ok && r.count, 1);
    // 剩余 diff = 只有 B（未分配）
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.hunks.length, 1);
    assert.strictEqual(fc.hunks[0].added[0], 'B1');
    assert.strictEqual(
      readFile(dir, 'f.txt'),
      'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\n',
    );
    // CL 的记录已清理；changelist 本身保留（delete 才移除）
    assert.strictEqual(store.recordsWithOwner(dir, 'f.txt').length, 0);
    assert.ok(store.changelistsOf(dir).some((c) => c.id === cl.id));
    // 再次撤销 → 已无该 changelist 的 hunks → empty
    const r2 = await discardChangelist(gitSvc, store, dir, cl.id);
    assert.ok(!r2.ok && r2.error === 'empty', JSON.stringify(r2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discard：撤销 Unassigned 视图的修改，已分配的 hunks 保留', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    const r = await discardViewChanges(gitSvc, store, dir, 'f.txt', 'unassigned');
    assert.ok(r.ok, JSON.stringify(r));
    // 剩余 diff = 只有 A（CL 的）
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.hunks.length, 1);
    assert.strictEqual(fc.hunks[0].added[0], 'A1');
    assert.strictEqual(
      readFile(dir, 'f.txt'),
      'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n',
    );
    // CL 的记录保留
    assert.strictEqual(store.recordsWithOwner(dir, 'f.txt').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discard：未跟踪文件撤销 = 删除文件，记录清理', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'v1\n');
    commitAll(dir, 'init');
    writeFile(dir, 'new.txt', 'n1\nn2\n');
    const { gitSvc, store } = newEngine(dir);
    const cl = store.createChangelist(dir, 'CL');
    const fc = makeUntrackedChange('new.txt', 'n1\nn2\n');
    store.setHunkOwners(
      dir,
      'new.txt',
      fc.hunks.map((h) => ({ id: h.id, oldStart: h.oldStart, oldLines: h.oldLines })),
      cl.id,
    );
    const r = await discardViewChanges(gitSvc, store, dir, 'new.txt', cl.id);
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(!fs.existsSync(path.join(dir, 'new.txt')), 'untracked file must be removed');
    assert.strictEqual(store.recordsWithOwner(dir, 'new.txt').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discard：视图下没有修改时返回 empty', async () => {
  const { dir, gitSvc, store, cl } = await setupTwoHunkScenario();
  try {
    // 撤销未分配视图后，再撤销一次 → 已无未分配 hunks
    const r1 = await discardViewChanges(gitSvc, store, dir, 'f.txt', 'unassigned');
    assert.ok(r1.ok, JSON.stringify(r1));
    const r2 = await discardViewChanges(gitSvc, store, dir, 'f.txt', 'unassigned');
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.ok || r2.error, 'empty');
    // 文件内容保持 = HEAD + A（未被第二次撤销误伤）
    assert.strictEqual(
      readFile(dir, 'f.txt'),
      'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= default（未分配）批量操作 =================

test('default: buildUnassignedPatch 只含未分配的 hunks', async () => {
  const { dir, gitSvc, store } = await setupTwoHunkScenario();
  try {
    const built = await buildUnassignedPatch(gitSvc, store, dir);
    assert.ok(built);
    // committedIds 必须填被提交 hunks 的 id：restore_patch 靠它过滤 staged 快照（bug1 回归）
    assert.strictEqual(built!.committedIds.size, 1);
    const ids = [...built!.committedIds.values()][0];
    assert.strictEqual(ids.size, 1);
    const fc = parseGitDiff(built!.patch)[0];
    assert.strictEqual(fc.hunks.length, 1);
    assert.strictEqual(fc.hunks[0].added[0], 'B1'); // A 已分配 → 不在 patch 里
    assert.ok(ids.has(fc.hunks[0].id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default: 提交未分配改动——只提交 B，A 保留在 CL 且 worktree 不变', async () => {
  const { dir, gitSvc, store, cl, hunkA } = await setupTwoHunkScenario();
  try {
    const before = readFile(dir, 'f.txt');
    const r = await commitUnassigned({
      git: gitSvc,
      store,
      repoRoot: dir,
      message: 'fix: B',
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(git(dir, ['log', '-1', '--format=%s']).trim(), 'fix: B');
    const after = parseGitDiff(await gitSvc.diffWorktree(dir));
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].hunks.length, 1);
    assert.strictEqual(after[0].hunks[0].id, hunkA.id); // 只剩 CL 的 A
    assert.strictEqual(readFile(dir, 'f.txt'), before);
    // CL 的记录仍在
    assert.strictEqual(store.recordsWithOwner(dir, 'f.txt').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default: 暂存未分配改动——index 只含 B，worktree 不变', async () => {
  const { dir, gitSvc, store, hunkB } = await setupTwoHunkScenario();
  try {
    const before = readFile(dir, 'f.txt');
    const r = await stageUnassigned(gitSvc, store, dir);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.ok && r.stagedCount, 1);
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1);
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, hunkB.id);
    assert.strictEqual(readFile(dir, 'f.txt'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default: 撤销未分配改动——只剩 CL 的 A，记录保留', async () => {
  const { dir, gitSvc, store, hunkA } = await setupTwoHunkScenario();
  try {
    const r = await discardUnassigned(gitSvc, store, dir);
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.ok && r.count, 1);
    const after = parseGitDiff(await gitSvc.diffWorktree(dir));
    assert.strictEqual(after.length, 1);
    assert.strictEqual(after[0].hunks[0].id, hunkA.id);
    assert.strictEqual(
      readFile(dir, 'f.txt'),
      'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13\nl14\n',
    );
    assert.strictEqual(store.recordsWithOwner(dir, 'f.txt').length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= ChangeDetector / gitService（符号链接路径回归） =================

test('detector: 符号链接路径下刷新不丢文件，分配后新 hunk 回 Unassigned', async () => {
  const dir = makeRepo();
  const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-store-')), 'store.json');
  const link = path.join(os.tmpdir(), `sc-link-${path.basename(dir)}`);
  let symlinkOk = true;
  try {
    fs.symlinkSync(dir, link); // 模拟 /tmp → /private/tmp 这类符号链接差异
  } catch {
    symlinkOk = false; // 无权限创建符号链接的平台跳过
  }
  if (!symlinkOk) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(storePath, { recursive: true, force: true });
    return;
  }
  try {
    const gitSvc = new GitService(GIT);
    const store = new ChangelistStore(storePath);
    const det = new ChangeDetector(gitSvc, store, () => [link]);
    const lines = Array.from({ length: 18 }, (_, i) => `l${i + 1}`).join('\n');
    writeFile(dir, 'f.txt', lines + '\n');
    commitAll(dir, 'init');

    // 用户视角路径（符号链接形式）触发保存刷新
    const userPath = (rel: string) => path.join(link, rel);

    writeFile(dir, 'f.txt', 'l1\nA1\n' + lines.split('\n').slice(2).join('\n') + '\n');
    await det.refreshAll();
    const root = await det.resolveRepo(userPath('f.txt'));
    assert.ok(root, 'resolveRepo through symlink must resolve');
    let m = det.getModel(root!);
    assert.ok(m && m.files.length === 1 && m.files[0].change.path === 'f.txt');
    assert.strictEqual(m.files[0].hunks.length, 1);

    // 分配进 changelist
    const cl = store.createChangelist(root!, 'CL');
    store.setHunkOwners(
      root!,
      'f.txt',
      m!.files[0].hunks.map((h) => ({ id: h.hunk.id, oldStart: h.hunk.oldStart, oldLines: h.hunk.oldLines })),
      cl.id,
    );
    await det.refreshAll();
    m = det.getModel(root!);
    assert.strictEqual(m!.files[0].hunks[0].ownerId, cl.id);

    // 远端新增修改 → 刷新后文件仍在，新 hunk 回到 Unassigned（bug 1 回归）
    writeFile(dir, 'f.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\nl15\nl16\nl17\nl18\n');
    await det.refreshFile(userPath('f.txt'));
    m = det.getModel(root!);
    assert.ok(m && m.files.length === 1, 'file must stay visible after refresh through symlink');
    assert.deepStrictEqual(
      m.files[0].hunks.map((h) => h.ownerId),
      [cl.id, null],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(link, { recursive: true, force: true });
    fs.rmSync(storePath, { recursive: true, force: true });
  }
});

test('git: headFileContent 返回 HEAD 原始字节，未跟踪返回 null', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'v1\n');
    commitAll(dir, 'init');
    const gitSvc = new GitService(GIT);
    const buf = await gitSvc.headFileContent(dir, 'f.txt');
    assert.ok(buf);
    assert.strictEqual(buf!.toString('utf8'), 'v1\n');

    // 未跟踪文件：HEAD 中没有 → null
    writeFile(dir, 'g.txt', 'untracked\n');
    assert.strictEqual(await gitSvc.headFileContent(dir, 'g.txt'), null);

    // 含空格/中文路径（diff 视图展示这类仓库时需要）
    writeFile(dir, '中文 文件.txt', 'x\n');
    commitAll(dir, 'c2');
    const cjk = await gitSvc.headFileContent(dir, '中文 文件.txt');
    assert.ok(cjk && cjk.toString('utf8') === 'x\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git: 文件名含 * 的通配符字符——--literal-pathspecs 回归', async () => {
  const dir = makeRepo();
  try {
    // 两个名字互为 glob 匹配的文件（a*b.txt 能匹配 axb.txt）
    writeFile(dir, 'a*b.txt', 'one\n');
    writeFile(dir, 'axb.txt', 'two\n');
    commitAll(dir, 'init');
    writeFile(dir, 'a*b.txt', 'one\nchanged\n');
    writeFile(dir, 'axb.txt', 'two\nchanged\n');
    const gitSvc = new GitService(GIT);

    // diffFile：修复前 glob 会同时输出 axb.txt → 文件级 path 对不上 → 视图丢文件
    const d = parseGitDiff(await gitSvc.diffFile(dir, 'a*b.txt'));
    assert.strictEqual(d.length, 1, 'diffFile must only return the literal path');
    assert.strictEqual(d[0].path, 'a*b.txt');
    assert.strictEqual(d[0].hunks.length, 1);

    // isUntracked：同名 untracked 文件存在时，修复前 glob 匹配输出 axb.txt → 误判 tracked
    writeFile(dir, 'a?b.txt', 'untracked?\n'); // 也能被 a*b.txt glob 命中
    writeFile(dir, 'a*c.txt', 'untracked*\n');
    assert.strictEqual(await gitSvc.isUntracked(dir, 'a*b.txt'), false, 'tracked must stay tracked');
    assert.strictEqual(await gitSvc.isUntracked(dir, 'a?b.txt'), true, 'untracked must be detected');
    assert.strictEqual(await gitSvc.isUntracked(dir, 'a*c.txt'), true, 'untracked must be detected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('git: applyPatchToTempFile 按仓库隔离临时目录（多仓库同名文件不互踩）', async () => {
  const dir1 = makeRepo();
  const dir2 = makeRepo();
  try {
    writeFile(dir1, 'a.txt', 'repo1-head\n');
    writeFile(dir2, 'a.txt', 'repo2-head\n');
    commitAll(dir1, 'init');
    commitAll(dir2, 'init');
    writeFile(dir1, 'a.txt', 'repo1-head\nrepo1-mod\n');
    writeFile(dir2, 'a.txt', 'repo2-head\nrepo2-mod\n');
    const gitSvc = new GitService(GIT);

    const p1 = parseGitDiff(await gitSvc.diffWorktree(dir1))[0];
    const p2 = parseGitDiff(await gitSvc.diffWorktree(dir2))[0];
    const t1 = await gitSvc.applyPatchToTempFile(dir1, 'a.txt', serializePatch([p1]), 'view1');
    const t2 = await gitSvc.applyPatchToTempFile(dir2, 'a.txt', serializePatch([p2]), 'view1');
    assert.ok(t1 && t2);
    assert.strictEqual(fs.readFileSync(t1!, 'utf8'), 'repo1-head\nrepo1-mod\n');
    assert.strictEqual(fs.readFileSync(t2!, 'utf8'), 'repo2-head\nrepo2-mod\n');
    assert.notStrictEqual(t1, t2, 'temp files must be isolated per repo');
    // 同仓库同文件、不同视图（variant）→ 不同路径：可同时打开多个 diff 标签页
    const t3 = await gitSvc.applyPatchToTempFile(dir1, 'a.txt', serializePatch([p1]), 'view2');
    assert.ok(t3);
    assert.notStrictEqual(t3, t1, 'same file in different views must not share a temp file');
    // 同仓库同文件同视图 → 复用同一路径（再次点击激活既有标签页，不重复开）
    const t4 = await gitSvc.applyPatchToTempFile(dir1, 'a.txt', serializePatch([p1]), 'view1');
    assert.strictEqual(t4, t1, 'same view reuses the same temp path');
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('git: sweepSynthDir 只删过期的合成 diff 临时文件', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\n');
    commitAll(dir, 'init');
    writeFile(dir, 'f.txt', 'l1\nchanged\n');
    const gitSvc = new GitService(GIT);
    // 目录不存在时静默返回（无残留场景不报错）
    gitSvc.sweepSynthDir(24 * 3600 * 1000);

    const patch = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    const tmp = await gitSvc.applyPatchToTempFile(dir, 'f.txt', serializePatch([patch]), 'viewA');
    assert.ok(tmp && fs.existsSync(tmp!));
    const repoSynthDir = path.dirname(tmp!);

    // 把 mtime 调成 2 天前 → 应被清扫
    const old = Date.now() / 1000 - 2 * 86400;
    fs.utimesSync(tmp!, old, old);
    gitSvc.sweepSynthDir(24 * 3600 * 1000);
    assert.ok(!fs.existsSync(tmp!), '过期的合成文件应被删除');

    // 新合成的文件 → 保留（可能被正在恢复的 diff 标签页引用）
    const tmp2 = await gitSvc.applyPatchToTempFile(dir, 'f.txt', serializePatch([patch]), 'viewA');
    assert.ok(tmp2 && fs.existsSync(tmp2!));
    gitSvc.sweepSynthDir(24 * 3600 * 1000);
    assert.ok(fs.existsSync(tmp2!), '24h 内的合成文件应保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default: 已有 staged 快照时提交未分配改动——staged 状态完整保留（committedIds 回归）', async () => {
  const { dir, gitSvc, store, hunkA } = await setupTwoHunkScenario();
  try {
    // 整文件 stage（A+B 都进 index）——恢复时必须把 A 过滤回 index、B 已随提交离开
    git(dir, ['add', 'f.txt']);
    const before = readFile(dir, 'f.txt');
    const r = await commitUnassigned({
      git: gitSvc,
      store,
      repoRoot: dir,
      message: 'fix: B',
    });
    assert.ok(r.ok, JSON.stringify(r));
    // 提交后 staged 快照 = 只剩 CL 的 A
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1, 'staged state must survive default commit');
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, hunkA.id);
    // worktree 未动，未提交 diff = 只剩 A
    assert.strictEqual(readFile(dir, 'f.txt'), before);
    const after = parseGitDiff(await gitSvc.diffWorktree(dir));
    assert.strictEqual(after[0].hunks.length, 1);
    assert.strictEqual(after[0].hunks[0].id, hunkA.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine: 重复暂存已暂存的 hunks——幂等 no-op（优化5 回归）', async () => {
  const { dir, gitSvc, store, cl, hunkA, hunkB } = await setupTwoHunkScenario();
  try {
    const r1 = await stageUnassigned(gitSvc, store, dir);
    assert.ok(r1.ok && r1.stagedCount === 1, JSON.stringify(r1));
    // 再次暂存：无剩余可暂存 hunk → ok + 0，而不是 applyFailed
    const r2 = await stageUnassigned(gitSvc, store, dir);
    assert.ok(r2.ok, JSON.stringify(r2));
    assert.strictEqual(r2.ok && r2.stagedCount, 0, 'repeat stage must be a no-op');
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1);
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, hunkB.id);
    // changelist 级重复暂存同样幂等（A 还未暂存，正常暂存 1 处）
    const r3 = await stageChangelist({ git: gitSvc, store, repoRoot: dir, changelistId: cl.id });
    assert.ok(r3.ok && r3.stagedCount === 1, JSON.stringify(r3));
    const r4 = await stageChangelist({ git: gitSvc, store, repoRoot: dir, changelistId: cl.id });
    assert.ok(r4.ok && r4.stagedCount === 0, 'repeat changelist stage must be a no-op');
    const staged2 = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged2[0].hunks.length, 2);
    assert.deepStrictEqual(
      new Set(staged2[0].hunks.map((h) => h.id)),
      new Set([hunkA.id, hunkB.id]),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= -U0 块级拆分 =================

test('U0: 间隔 1 行的改动拆分为两个 hunk（近距拆分核心回归）', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    commitAll(dir, 'init');
    // line2 与 line4 只隔 line3（1 行）——-U3 时代必被合并，-U0 必须拆开
    writeFile(dir, 'f.txt', 'l1\nA\nl3\nB\nl5\n');
    const { gitSvc, store } = newEngine(dir);
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.hunks.length, 2, 'nearby edits must be separate hunks at -U0');
    const [block2, block4] = fc.hunks;
    assert.strictEqual(block2.oldStart, 2);
    assert.strictEqual(block4.oldStart, 4);
    const cl = store.createChangelist(dir, 'CL');
    store.setHunkOwners(
      dir,
      'f.txt',
      [{ id: block2.id, oldStart: block2.oldStart, oldLines: block2.oldLines }],
      cl.id,
    );
    const before = readFile(dir, 'f.txt');
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'block2',
    });
    assert.ok(r.ok, JSON.stringify(r));
    // HEAD 只含 line2 改动；worktree 逐字节不变；剩余 diff 只有 line4 块
    assert.strictEqual(git(dir, ['show', 'HEAD:f.txt']), 'l1\nA\nl3\nl4\nl5\n');
    assert.strictEqual(readFile(dir, 'f.txt'), before);
    const rest = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(rest.hunks.length, 1);
    assert.strictEqual(rest.hunks[0].oldStart, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U0: 相邻行改动仍合并为单 hunk（块级拆分边界）', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    commitAll(dir, 'init');
    writeFile(dir, 'f.txt', 'l1\nA\nB\nl4\nl5\n');
    const { gitSvc } = newEngine(dir);
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.hunks.length, 1, 'adjacent edits must stay one hunk');
    assert.strictEqual(fc.hunks[0].oldLines, 2);
    assert.strictEqual(fc.hunks[0].newLines, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parser: -U0 头部格式（无逗号计数 / 纯删除 newLines=0）与可应用性', () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    commitAll(dir, 'init');
    // 改 line2 + 删 line5：间隔 2 行，-U0 下各自独立成块
    writeFile(dir, 'f.txt', 'l1\nA\nl3\nl4\n');
    const text = git(dir, ['-c', 'core.quotepath=false', 'diff', '-U0', '--no-renames', 'HEAD', '--']);
    const fc = parseGitDiff(text)[0];
    assert.strictEqual(fc.hunks.length, 2);
    const [mod, del] = fc.hunks;
    // 单行修改：规范化头（显式计数、无 func context 后缀）
    assert.strictEqual(mod.header, '@@ -2,1 +2,1 @@');
    assert.strictEqual(mod.newLines, 1);
    // 纯删除：new 侧 0 行
    assert.strictEqual(del.header, '@@ -5,1 +4,0 @@');
    assert.strictEqual(del.newLines, 0);
    assert.deepStrictEqual(del.removed, ['l5']);
    // 序列化后可应用于 read-tree HEAD 的临时 index（-U0 无上下文 patch 的提交路径）
    const patch = serializePatch([fc]);
    const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sc-idx-')), 'index');
    try {
      git(dir, ['read-tree', 'HEAD'], undefined, { GIT_INDEX_FILE: tmpIndex });
      git(
        dir,
        ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn', '-'],
        patch,
        { GIT_INDEX_FILE: tmpIndex },
      );
    } finally {
      fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hunkHitsSelection: 纯删除块 old 侧命中 / 新增替换块 new 侧命中 / 部分命中整块', () => {
  // 纯删除块：old 区间 [5,6]，new 侧为空
  const del = makeHunk('f', ['l5', 'l6'], [], 5, 2);
  assert.strictEqual(hunkHitsSelection(del, 5, 6), true);
  assert.strictEqual(hunkHitsSelection(del, 3, 4), false);
  assert.strictEqual(hunkHitsSelection(del, 1, 5), true);
  // 替换块：new 侧 [2,2]
  const mod = makeHunk('f', ['l2'], ['A'], 2);
  assert.strictEqual(hunkHitsSelection(mod, 2, 2), true);
  assert.strictEqual(hunkHitsSelection(mod, 3, 3), false);
  // 新文件块：old 侧为空，new 侧 [1,3]
  const add = makeHunk('f', [], ['a', 'b', 'c'], 0, 0);
  assert.strictEqual(hunkHitsSelection(add, 1, 3), true);
  assert.strictEqual(hunkHitsSelection(add, 4, 5), false);
  // 相邻合并块：只选中部分行仍整块命中（整块分配语义）
  const adj = makeHunk('f', ['l2', 'l3'], ['A', 'B'], 2, 2);
  assert.strictEqual(hunkHitsSelection(adj, 2, 2), true);
});

test('U0 端到端: 纯删除块分配/提交，staged 快照按 id 隔离', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    commitAll(dir, 'init');
    // 删 line2 + 改 line5→X：两个独立块（间隔 2 行）
    writeFile(dir, 'f.txt', 'l1\nl3\nl4\nX\n');
    const { gitSvc, store } = newEngine(dir);
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(fc.hunks.length, 2);
    const delBlock = fc.hunks.find((h) => h.newLines === 0);
    const modBlock = fc.hunks.find((h) => h.newLines > 0);
    assert.ok(delBlock && modBlock, 'expected one deletion block and one modification block');
    const cl = store.createChangelist(dir, 'CL');
    store.setHunkOwners(
      dir,
      'f.txt',
      [{ id: delBlock.id, oldStart: delBlock.oldStart, oldLines: delBlock.oldLines }],
      cl.id,
    );
    git(dir, ['add', 'f.txt']); // 整文件暂存（含两个块）
    const before = readFile(dir, 'f.txt');
    const r = await commitChangelist({
      git: gitSvc,
      store,
      repoRoot: dir,
      changelistId: cl.id,
      message: 'del',
    });
    assert.ok(r.ok, JSON.stringify(r));
    assert.strictEqual(r.warning, undefined, 'restore must succeed cleanly: ' + JSON.stringify(r));
    // HEAD 只有删除；worktree 逐字节不变；restore 后 staged 只剩 line5 块
    assert.strictEqual(git(dir, ['show', 'HEAD:f.txt']), 'l1\nl3\nl4\nl5\n');
    assert.strictEqual(readFile(dir, 'f.txt'), before);
    const staged = parseGitDiff(await gitSvc.diffStaged(dir));
    assert.strictEqual(staged.length, 1);
    assert.strictEqual(staged[0].hunks.length, 1);
    assert.strictEqual(staged[0].hunks[0].id, modBlock.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('U0 端到端: 删除块撤销（删除块 + 后续修改块共存）', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\nl4\nl5\n');
    commitAll(dir, 'init');
    writeFile(dir, 'f.txt', 'l1\nl3\nl4\nX\n');
    const { gitSvc, store } = newEngine(dir);
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    const delBlock = fc.hunks.find((h) => h.newLines === 0);
    assert.ok(delBlock);
    const cl = store.createChangelist(dir, 'CL');
    store.setHunkOwners(
      dir,
      'f.txt',
      [{ id: delBlock.id, oldStart: delBlock.oldStart, oldLines: delBlock.oldLines }],
      cl.id,
    );
    const r = await discardChangelist(gitSvc, store, dir, cl.id);
    assert.ok(r.ok, JSON.stringify(r));
    // 删除块被撤销（l2 恢复），修改块保留（line5 仍是 X）
    assert.strictEqual(readFile(dir, 'f.txt'), 'l1\nl2\nl3\nl4\nX\n');
    const rest = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    assert.strictEqual(rest.hunks.length, 1);
    assert.strictEqual(rest.hunks[0].newLines, 1);
    assert.strictEqual(store.recordsWithOwner(dir, 'f.txt').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 暂存状态圆点（staged 缓存与三态判定） =================

test('staged: stageStateOf / combineStageStates 纯函数边界', () => {
  assert.strictEqual(stageStateOf([], new Set()), 'none'); // 空 ids
  assert.strictEqual(stageStateOf(['a'], undefined), 'none'); // 无缓存
  assert.strictEqual(stageStateOf(['a'], new Set(['a'])), 'all');
  assert.strictEqual(stageStateOf(['a', 'b'], new Set(['a'])), 'partial');
  assert.strictEqual(stageStateOf(['a', 'b'], new Set(['a', 'b'])), 'all');
  assert.strictEqual(stageStateOf(['a', 'b'], new Set()), 'none'); // 空集合
  assert.strictEqual(combineStageStates([]), 'none'); // 空数组
  assert.strictEqual(combineStageStates(['all', 'all']), 'all');
  assert.strictEqual(combineStageStates(['none', 'none']), 'none');
  assert.strictEqual(combineStageStates(['all', 'none']), 'partial');
  assert.strictEqual(combineStageStates(['partial', 'all']), 'partial');
});

test('staged: refreshRepo 缓存只含真正暂存的 hunk', async () => {
  const { dir, gitSvc, store, hunkB } = await setupTwoHunkScenario();
  try {
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    assert.strictEqual(det.stagedIds(root, 'f.txt'), undefined); // 无暂存 → undefined

    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    const bOnly = serializePatch([{ ...fc, hunks: [hunkB] }]);
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'], bOnly);
    await det.refreshAll();
    const staged = det.stagedIds(root, 'f.txt');
    assert.ok(staged && staged.has(hunkB.id) && !staged.has(fc.hunks[0].id));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: 三态集成——无暂存 none / 部分 partial / 全暂存 all', async () => {
  const { dir, gitSvc, store, hunkA, hunkB } = await setupTwoHunkScenario();
  try {
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    const m = det.getModel(root)!;
    const allIds = m.files[0].hunks.map((h) => h.hunk.id);
    // 无暂存 → none
    assert.strictEqual(stageStateOf(allIds, det.stagedIds(root, 'f.txt')), 'none');

    // 只暂存 B → partial
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'],
      serializePatch([{ ...fc, hunks: [hunkB] }]));
    await det.refreshAll();
    assert.strictEqual(stageStateOf(allIds, det.stagedIds(root, 'f.txt')), 'partial');

    // 全暂存 → all
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'],
      serializePatch([{ ...fc, hunks: [hunkA] }]));
    await det.refreshAll();
    assert.strictEqual(stageStateOf(allIds, det.stagedIds(root, 'f.txt')), 'all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: 提交后缓存如实反映——提交的消失、restore 保留的仍在', async () => {
  const { dir, gitSvc, store, cl, hunkA, hunkB } = await setupTwoHunkScenario();
  try {
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'],
      serializePatch([{ ...fc, hunks: [hunkB] }]));
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkB.id));

    // 提交 changelist（A）→ restore 后 index 仍保留 B
    const r1 = await commitChangelist({
      git: gitSvc, store, repoRoot: dir, changelistId: cl.id, message: 'c1',
    });
    assert.ok(r1.ok, JSON.stringify(r1));
    await det.refreshAll();
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkB.id), 'restore 保留的 staged 必须仍在缓存');
    assert.ok(!det.stagedIds(root, 'f.txt')?.has(hunkA.id), '提交的 hunk 不在缓存');

    // 再提交未分配（B）→ index 对齐新 HEAD，缓存清空
    const r2 = await commitUnassigned({
      git: gitSvc, store, repoRoot: dir, message: 'c2',
    });
    assert.ok(r2.ok, JSON.stringify(r2));
    await det.refreshAll();
    assert.strictEqual(det.stagedIds(root, 'f.txt'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: 未跟踪文件 git add 后 id 匹配（绿点）', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'v1\n');
    commitAll(dir, 'init');
    writeFile(dir, 'new.txt', 'hello\nworld\n');
    const { gitSvc, store } = newEngine(dir);
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    const m = det.getModel(root)!;
    const newFile = m.files.find((f) => f.change.path === 'new.txt');
    assert.ok(newFile && newFile.change.kind === 'new');
    const modelId = newFile!.hunks[0].hunk.id;
    assert.strictEqual(det.stagedIds(root, 'new.txt'), undefined); // 未 stage

    git(dir, ['add', 'new.txt']);
    await det.refreshAll();
    const staged = det.stagedIds(root, 'new.txt');
    assert.ok(staged && staged.has(modelId), 'git add 后合成 hunk id 必须命中缓存');
    assert.strictEqual(stageStateOf([modelId], staged), 'all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: 未跟踪 CRLF 文件（autocrlf）add 后 EOL 归一匹配', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'v1\n');
    commitAll(dir, 'init');
    git(dir, ['config', 'core.autocrlf', 'true']);
    writeFile(dir, 'crlf.txt', 'l1\r\nl2\r\n');
    const { gitSvc, store } = newEngine(dir);
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    const nf = det.getModel(root)!.files.find((f) => f.change.path === 'crlf.txt');
    assert.ok(nf);
    const modelId = nf!.hunks[0].hunk.id;
    git(dir, ['add', 'crlf.txt']);
    await det.refreshAll();
    const staged = det.stagedIds(root, 'crlf.txt');
    assert.ok(staged && staged.has(modelId), 'CRLF 下 diffStaged 的 hunk id 必须与模型一致');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: staged 后工作区再编辑同一 hunk → id 失配 → 未暂存（feature 语义）', async () => {
  const { dir, gitSvc, store, hunkA, hunkB } = await setupTwoHunkScenario();
  try {
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'],
      serializePatch([{ ...fc, hunks: [hunkB] }]));
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkB.id));

    // 工作区把 B1 改成 B2（index 中仍是旧版 B1）
    writeFile(dir, 'f.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB2\nl12\nl13\nl14\n');
    await det.refreshAll();
    const m = det.getModel(root)!;
    // A 内容未变 → id 不变；B 变了 → 新 id（旧 hunkB.id 不应再出现）
    const ids = m.files[0].hunks.map((h) => h.hunk.id);
    assert.ok(ids.includes(hunkA.id), 'A 未变，id 不变');
    assert.ok(!ids.includes(hunkB.id), 'B 内容已变，旧 id 消失');
    const newB = m.files[0].hunks.find((h) => h.hunk.id !== hunkA.id)!;
    assert.ok(newB, '新版本 hunk 必须在模型中');
    assert.ok(!det.stagedIds(root, 'f.txt')?.has(newB.hunk.id), '新版本未暂存 → 失配');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: discard 后缓存同步（index 反向 apply 被如实反映）', async () => {
  const { dir, gitSvc, store, cl, hunkA, hunkB } = await setupTwoHunkScenario();
  try {
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'], serializePatch([fc]));
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkA.id));
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkB.id));

    const r = await discardChangelist(gitSvc, store, dir, cl.id);
    assert.ok(r.ok, JSON.stringify(r));
    await det.refreshAll();
    const staged = det.stagedIds(root, 'f.txt');
    assert.ok(staged && !staged.has(hunkA.id), 'A 撤销后不在 index');
    assert.ok(staged.has(hunkB.id), 'B 保留在 index');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: refreshFile 不重算缓存（保存不改变 index）', async () => {
  const { dir, gitSvc, store, hunkB } = await setupTwoHunkScenario();
  try {
    const fc = parseGitDiff(await gitSvc.diffWorktree(dir))[0];
    git(dir, ['apply', '--cached', '--unidiff-zero', '--whitespace=nowarn'],
      serializePatch([{ ...fc, hunks: [hunkB] }]));
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkB.id));

    // 保存文件（追加行，新增 hunk）→ refreshFile 后缓存不变
    writeFile(dir, 'f.txt', 'l1\nA1\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nB1\nl12\nl13\nl14\nl15\n');
    await det.refreshFile(path.join(dir, 'f.txt'));
    const m = det.getModel(root)!;
    assert.ok(m.files[0].hunks.some((h) => h.hunk.id === hunkB.id));
    assert.ok(det.stagedIds(root, 'f.txt')?.has(hunkB.id), 'refreshFile 不得清空 staged 缓存');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: 删除文件 git add 后 id 匹配', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'f.txt', 'l1\nl2\nl3\n');
    commitAll(dir, 'init');
    fs.rmSync(path.join(dir, 'f.txt')); // worktree 删除，index 不动
    const { gitSvc, store } = newEngine(dir);
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll();
    const m = det.getModel(root)!;
    const df = m.files.find((f) => f.change.path === 'f.txt');
    assert.ok(df && df.change.kind === 'deleted');
    const delId = df!.hunks[0].hunk.id;
    assert.strictEqual(det.stagedIds(root, 'f.txt'), undefined); // 未 stage

    git(dir, ['add', '-A']);
    await det.refreshAll();
    const staged = det.stagedIds(root, 'f.txt');
    assert.ok(staged && staged.has(delId), '删除 hunk 必须命中缓存');
    assert.strictEqual(stageStateOf([delId], staged), 'all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('staged: unborn HEAD 仓库 refreshAll 不崩（diff --cached 对比空树）', async () => {
  const dir = makeRepo();
  try {
    writeFile(dir, 'new.txt', 'hello\n');
    const { gitSvc, store } = newEngine(dir);
    const det = new ChangeDetector(gitSvc, store, () => [dir]);
    // root 是 git 的 realpath（macOS /var → /private/var），模型/缓存按 root 键
    const root = (await det.resolveRepo(dir))!;
    await det.refreshAll(); // 不抛异常即可
    const m = det.getModel(root);
    assert.ok(m && m.files.some((f) => f.change.path === 'new.txt'));
    assert.ok(!m!.headExists);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ================= 主入口 =================

async function main(): Promise<void> {
  const started = Date.now();
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      process.stdout.write('PASS ' + t.name + '\n');
    } catch (e) {
      failures.push(t.name + ': ' + (e instanceof Error ? (e.stack ?? e.message) : String(e)));
      process.stdout.write('FAIL ' + t.name + '\n');
    }
  }
  process.stdout.write(`\n${passed} passed, ${failures.length} failed (${Date.now() - started}ms)\n`);
  if (failures.length > 0) {
    process.stdout.write('\n--- Failures ---\n');
    for (const f of failures) {
      process.stdout.write(f + '\n\n');
    }
    process.exitCode = 1;
  }
}

void main();
