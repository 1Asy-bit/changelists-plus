/**
 * 扩展入口：装配各模块、注册命令与事件管线。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { initI18n, t } from './i18n';
import { GitService } from './gitService';
import { ChangelistStore } from './changelistStore';
import { ChangeDetector } from './changeDetector';
import { ChangelistDragAndDrop, ChangelistTreeProvider } from './treeView';
import { HEAD_SCHEME, HeadFileSystemProvider } from './headFsProvider';
import { registerCommands } from './commands';

/** 模块级引用：deactivate 时同步 flush，保证退出前 pending 写入真正落盘 */
let store: ChangelistStore | undefined;

/**
 * 本会话创建的合成 diff 临时文件（diff 视图右侧内容）→ 其所属仓库与相对路径。
 * 用途有二：视图关闭即删（onDidCloseTextDocument）、deactivate 清残留、
 * 下次启动 TTL 清扫（崩溃残留，见 git.sweepSynthDir）；以及保存时 3-way merge
 * 写回原始文件（见 onDidSaveTextDocument 分支）。
 */
const tempFileOwners = new Map<string, { repoRoot: string; relPath: string; base: Buffer }>();

/**
 * 文件批量刷新升级阈值：防抖窗口内变化的文件数 ≥ 此值时，不再逐个
 * refreshFile（2 进程/文件），而是升级为一次 refreshAll（4 进程/仓库）。
 * 4 文件 = 8 进程 > 全量 4 进程，且批量变化（checkout/build/批量脚本）
 * 本就该全量同步。
 */
const BATCH_REFRESH_THRESHOLD = 4;

export function activate(context: vscode.ExtensionContext): void {
  initI18n();
  const output = vscode.window.createOutputChannel(t('viewName'));
  const cfg = vscode.workspace.getConfiguration('changelistsPlus');
  const gitPath = cfg.get<string>('gitPath') || 'git';
  const git = new GitService(gitPath);
  // 启动清扫：清掉 >24h 的合成 diff 残留（崩溃/强退时没来得及删的）
  git.sweepSynthDir(24 * 60 * 60 * 1000);

  if (!context.storageUri) {
    vscode.window.showWarningMessage(t('storageDirMissing'));
    return;
  }
  // 局部 const：让 activate 内所有引用类型收窄为 ChangelistStore；
  // 模块级 store 只用于 deactivate 时 flush
  const s = new ChangelistStore(path.join(context.storageUri.fsPath, 'changelists.json'));
  store = s;
  for (const backupPath of s.warnings) {
    vscode.window.showWarningMessage(t('corruptStorage', backupPath));
  }

  // diff 视图左侧（HEAD 内容）的只读虚拟文件系统
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      HEAD_SCHEME,
      new HeadFileSystemProvider(git),
      { isReadonly: true },
    ),
  );

  const detector = new ChangeDetector(
    git,
    store,
    () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
  );
  const provider = new ChangelistTreeProvider(detector, s);
  const treeView = vscode.window.createTreeView('changelistsPlus', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new ChangelistDragAndDrop(detector, s, () => {
      void refreshAll();
    }),
  });

  const updateBadge = (): void => {
    let total = 0;
    for (const m of detector.snapshot()) {
      for (const c of m.changelists) {
        total += c.hunkCount;
      }
    }
    treeView.badge = { value: total, tooltip: t('assignedBadge', total) };
  };

  const refreshAll = async (): Promise<void> => {
    // HEAD 内容缓存失效：commit / 切分支 / reset 等任何 HEAD 变化都经 refreshAll 到达
    // （git watcher 500ms 防抖、命令尾部、工作区/配置变更），统一在此清缓存。
    // refreshFile（保存文件）不清——保存不改变 HEAD，缓存仍有效。
    git.clearHeadCache();
    // 视图重绘统一由 detector 的 'change' 事件驱动（refreshAll 内部 emit）——
    // 此前这里 return 后又显式 provider.refresh()/updateBadge()，同一数据被
    // 完整重建两轮，低配机上每轮都是全树重绘
    await detector.refreshAll();
  };

  // stage 命令尾部轻量刷新：只重算 index 暂存状态（1 进程/仓库，多仓库并行）——
  // stage 不改 worktree / 归属，全量三路 diff 是浪费；detector emit 'change'
  // 自动驱动树重绘 + badge 更新。commit / discard / 外部 git 操作仍走 refreshAll。
  const refreshStaged = async (): Promise<void> => {
    await Promise.all(detector.snapshot().map((m) => detector.refreshStagedOnly(m.repoRoot)));
  };

  // store 结构性变更（建/删/改名/分配）→ 全量刷新
  s.on('change', () => {
    void refreshAll();
  });
  // detector 每次刷新（全量或单文件）→ 重绘视图
  detector.on('change', () => {
    provider.refresh();
    updateBadge();
  });
  context.subscriptions.push({ dispose: () => s.removeAllListeners('change') });
  context.subscriptions.push({ dispose: () => detector.removeAllListeners('change') });

  // ---- 命令 ----
  registerCommands(context, {
    detector,
    store: s,
    git,
    output,
    refreshAll,
    refreshStaged,
    activeRepo: async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const root = await detector.resolveRepo(editor.document.uri.fsPath);
        if (root) {
          return { repoRoot: root };
        }
      }
      const first = detector.snapshot()[0];
      return first ? { repoRoot: first.repoRoot } : undefined;
    },
    trackTempFile: (p, owner) => {
      tempFileOwners.set(p, owner);
    },
  });

  // ---- 文件变化 → 单文件刷新（批量防抖；git 只能 diff 已保存内容） ----
  // 两个入口共用同一防抖窗口，对同一文件只刷一次：
  // - onDidSaveTextDocument：编辑器内保存
  // - onDidChangeWatchedFiles：外部修改（终端 / 外部工具直接写磁盘，不经编辑器）。
  //   内置 SCM 面板靠 VS Code 自己的 watcher 实时显示这类改动，而插件此前只响应
  //   编辑器保存与 .git 事件——终端改动的文件（如本仓库的源码）在 default 下不出现。
  // 新建 / 删除文件同样走这里（refreshFile 对 deleted 输出删除 diff）。
  //
  // 批量防抖：窗口内所有文件合并进同一个 timer。此前每文件独立 timer，终端批量
  // 写入（checkout / build / 批量脚本）时每个文件各起一组并发 git 进程——
  // 单文件刷新 = 2 进程/文件（isUntracked + diffFile），N 个文件 = 2N 进程，
  // 低配机上同时打满。到点时按数量分流：
  // - ≥ BATCH_REFRESH_THRESHOLD：升级为一次全量刷新（4 进程覆盖全部文件，
  //   顺带保证 staged 缓存一致）；批量变化大概率不是零星编辑，全量更划算
  // - 少量文件：逐个 refreshFile（只 diff 变更的文件，输出远小于全量）
  const pendingFiles = new Set<string>();
  let batchTimer: NodeJS.Timeout | undefined;
  const scheduleFileRefresh = (fsPath: string): void => {
    pendingFiles.add(fsPath);
    if (batchTimer) {
      clearTimeout(batchTimer);
    }
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      const files = [...pendingFiles];
      pendingFiles.clear();
      if (files.length >= BATCH_REFRESH_THRESHOLD) {
        void refreshAll();
      } else {
        for (const p of files) {
          void detector.refreshFile(p);
        }
      }
    }, 400);
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== 'file') {
        return;
      }
      const owner = tempFileOwners.get(doc.uri.fsPath);
      if (owner) {
        // diff 视图右侧是合成临时文件（HEAD + 该视图的修改）：保存时用 3-way
        // merge 把编辑结果合并回原始文件——其他视图（default / 其他 changelist）
        // 的修改在不相邻区域保留；改动重叠则拒绝写回并提示。
        // 不直接 scheduleFileRefresh(临时文件)：它在 tmp 目录，不属于任何仓库
        const r = await git.writeBackDiff(
          owner.repoRoot,
          owner.relPath,
          owner.base,
          Buffer.from(doc.getText(), 'utf8'),
        );
        if (!r.ok) {
          vscode.window.showWarningMessage(t('diffSaveFailed'));
        }
        scheduleFileRefresh(path.join(owner.repoRoot, owner.relPath));
        return;
      }
      scheduleFileRefresh(doc.uri.fsPath);
    }),
  );
  // 工作区文件 watcher（覆盖外部修改：终端 / 外部工具直接写磁盘，不经编辑器）。
  // 内置 SCM 面板靠 VS Code 自己的 watcher 实时显示这类改动，而插件此前只响应
  // 编辑器保存与 .git 事件——终端改动的文件（如本仓库的源码）在 default 下不出现。
  // 新建 / 删除文件同样走这里（refreshFile 对 deleted 输出删除 diff）。
  const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
  const onWorktreeChange = (uri: vscode.Uri): void => {
    const p = uri.fsPath;
    // .git 事件走 git watcher → refreshAll（单文件刷新会与其竞争版本号）；
    // node_modules / dist 被 .gitignore 排除，diff 不产生，跳过只省进程
    if (
      /(^|[\\/])\.git([\\/]|$)/.test(p) ||
      /(^|[\\/])(node_modules|dist)([\\/]|$)/.test(p)
    ) {
      return;
    }
    scheduleFileRefresh(p);
  };
  fileWatcher.onDidChange(onWorktreeChange);
  fileWatcher.onDidCreate(onWorktreeChange);
  fileWatcher.onDidDelete(onWorktreeChange);
  context.subscriptions.push(fileWatcher);

  // ---- 合成 diff 临时文件：文档（diff 标签页）关闭即删 ----
  // 只删登记过的合成文件；scheme 必须是 file（head 侧是自定义 scheme，不在此列）
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && tempFileOwners.delete(doc.uri.fsPath)) {
        try {
          fs.unlinkSync(doc.uri.fsPath);
        } catch {
          /* 文件可能已被清理/占用，留给 TTL 清扫兜底 */
        }
      }
    }),
  );

  // ---- git 事件（提交/分支变化）→ 防抖全量刷新 ----
  // commit 更新的是 refs（分离 HEAD 才动 HEAD），两者都要监听。
  // 分隔符无关匹配：Windows 的 fsPath 用 \（CLAUDE.md 跨平台要求），
  // 直接用 git 返回的路径不引入平台假设，正则同时接受 / 与 \。
  let gitEventTimer: NodeJS.Timeout | undefined;
  const onGitEvent = (uri: vscode.Uri): void => {
    const p = uri.fsPath;
    const isRelevant =
      /(^|[\\/])HEAD$/.test(p) ||
      /(^|[\\/])index$/.test(p) ||
      /(^|[\\/])packed-refs$/.test(p) ||
      p.includes('/refs/') ||
      p.includes('\\refs\\');
    if (!isRelevant) {
      return;
    }
    if (gitEventTimer) {
      clearTimeout(gitEventTimer);
    }
    gitEventTimer = setTimeout(() => {
      gitEventTimer = undefined;
      void refreshAll();
    }, 500);
  };
  /**
   * 监听真实 git 目录（`git rev-parse --git-dir`）而非假设 `.git` 是目录：
   * linked worktree / 子模块的 `.git` 是指针文件（内容指向真实 gitdir），
   * `.git/**` glob 匹配不到任何东西 → 提交/切分支后视图永不刷新。
   * gitdir 不在 workspace 内时 VS Code watcher 不生效（平台限制），维持现状。
   */
  const setupWatchers = async (): Promise<void> => {
    for (const w of watchers) {
      w.dispose();
    }
    watchers.length = 0;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const g = await git.getGitDir(folder.uri.fsPath);
      const gitDir = g && path.isAbsolute(g) ? g : g ? path.join(folder.uri.fsPath, g) : null;
      // gitdir 解析失败（非仓库目录）：回退旧行为，`.git/**` 匹配不到时无害
      const watcher = vscode.workspace.createFileSystemWatcher(
        gitDir
          ? new vscode.RelativePattern(gitDir, '**/*')
          : new vscode.RelativePattern(folder, '.git/**'),
      );
      watcher.onDidCreate(onGitEvent);
      watcher.onDidChange(onGitEvent);
      watcher.onDidDelete(onGitEvent);
      watchers.push(watcher);
    }
  };
  const watchers: vscode.FileSystemWatcher[] = [];
  void setupWatchers();
  context.subscriptions.push(
    ...watchers,
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      setupWatchers();
      void refreshAll();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void refreshAll();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('changelistsPlus')) {
        void refreshAll();
      }
    }),
  );

  void refreshAll();
}

export function deactivate(): void {
  // 所有订阅都挂在 context.subscriptions 上，随激活上下文自动清理。
  // save() 走 setImmediate 防抖，窗口关闭时可能来不及执行——这里同步 flush 兜底，
  // 保证最后一次写入（如刚分配的改动）在退出前落盘。
  store?.flush();
  // 清理本会话残留的合成 diff 临时文件；仍打开的文档保留——
  // 热退出（hot exit）恢复的 diff 标签页还引用着它们
  const open = new Set(vscode.workspace.textDocuments.map((d) => d.uri.fsPath));
  for (const p of tempFileOwners.keys()) {
    if (!open.has(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 忽略：可能已被清理 */
      }
    }
  }
  tempFileOwners.clear();
}
