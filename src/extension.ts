/**
 * 扩展入口：装配各模块、注册命令与事件管线。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { initI18n, t } from './i18n';
import { GitService } from './gitService';
import { ChangelistStore } from './changelistStore';
import { ChangeDetector } from './changeDetector';
import { ChangelistDragAndDrop, ChangelistTreeProvider } from './treeView';
import { HEAD_SCHEME, HeadFileSystemProvider } from './headFsProvider';
import { registerCommands } from './commands';

export function activate(context: vscode.ExtensionContext): void {
  initI18n();
  const output = vscode.window.createOutputChannel(t('viewName'));
  const cfg = vscode.workspace.getConfiguration('changelistsPlus');
  const gitPath = cfg.get<string>('gitPath') || 'git';
  const git = new GitService(gitPath, cfg.get<number>('contextLines') ?? 3);

  if (!context.storageUri) {
    vscode.window.showWarningMessage(t('storageDirMissing'));
    return;
  }
  const store = new ChangelistStore(path.join(context.storageUri.fsPath, 'changelists.json'));
  for (const backupPath of store.warnings) {
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
    () => vscode.workspace.getConfiguration('changelistsPlus').get<number>('contextLines') ?? 3,
    () => vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [],
  );
  const provider = new ChangelistTreeProvider(detector, store);
  const treeView = vscode.window.createTreeView('changelistsPlus', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: new ChangelistDragAndDrop(detector, store, () => {
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
  store.on('change', () => {
    void refreshAll();
  });
  // detector 每次刷新（全量或单文件）→ 重绘视图
  detector.on('change', () => {
    provider.refresh();
    updateBadge();
  });
  context.subscriptions.push({ dispose: () => store.removeAllListeners('change') });
  context.subscriptions.push({ dispose: () => detector.removeAllListeners('change') });

  // ---- 命令 ----
  registerCommands(context, {
    detector,
    store,
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

  // ---- .git 事件（提交/分支变化）→ 防抖全量刷新 ----
  // commit 更新的是 refs（分离 HEAD 才动 HEAD），两者都要监听
  let gitEventTimer: NodeJS.Timeout | undefined;
  const onGitEvent = (uri: vscode.Uri): void => {
    const p = uri.fsPath;
    const isRelevant =
      /(^|\/)HEAD$/.test(p) ||
      /(^|\/)index$/.test(p) ||
      /(^|\/)packed-refs$/.test(p) ||
      p.includes('/refs/');
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
  const setupWatchers = (): void => {
    for (const w of watchers) {
      w.dispose();
    }
    watchers.length = 0;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '.git/**'),
      );
      watcher.onDidCreate(onGitEvent);
      watcher.onDidChange(onGitEvent);
      watcher.onDidDelete(onGitEvent);
      watchers.push(watcher);
    }
  };
  const watchers: vscode.FileSystemWatcher[] = [];
  setupWatchers();
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
        const c = vscode.workspace.getConfiguration('changelistsPlus');
        git.updateContextLines(c.get<number>('contextLines') ?? 3);
        void refreshAll();
      }
    }),
  );

  void refreshAll();
}

export function deactivate(): void {
  // 所有订阅都挂在 context.subscriptions 上，随激活上下文自动清理
}
