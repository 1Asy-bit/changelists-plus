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
 * 本会话创建的合成 diff 临时文件（diff 视图右侧内容）。
 * 配套清理：视图关闭即删（onDidCloseTextDocument）、deactivate 清残留、
 * 下次启动 TTL 清扫（崩溃残留，见 git.sweepSynthDir）。
 */
const tempFiles = new Set<string>();

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
    await detector.refreshAll();
    provider.refresh();
    updateBadge();
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
    trackTempFile: (p) => {
      tempFiles.add(p);
    },
  });

  // ---- 保存后单文件刷新（防抖；git 只能 diff 已保存内容） ----
  const saveTimers = new Map<string, NodeJS.Timeout>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      const fsPath = doc.uri.fsPath;
      const prev = saveTimers.get(fsPath);
      if (prev) {
        clearTimeout(prev);
      }
      saveTimers.set(
        fsPath,
        setTimeout(() => {
          saveTimers.delete(fsPath);
          void detector.refreshFile(fsPath);
        }, 400),
      );
    }),
  );

  // ---- 合成 diff 临时文件：文档（diff 标签页）关闭即删 ----
  // 只删登记过的合成文件；scheme 必须是 file（head 侧是自定义 scheme，不在此列）
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (doc.uri.scheme === 'file' && tempFiles.delete(doc.uri.fsPath)) {
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
  for (const p of tempFiles) {
    if (!open.has(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* 忽略：可能已被清理 */
      }
    }
  }
  tempFiles.clear();
}
