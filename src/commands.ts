/**
 * 命令层：把 store / detector / engine 的能力暴露为 VS Code 命令与交互。
 * 树只有文件层（不展开 hunk）：文件节点总是按「所在视图」操作——
 * Unassigned 下的文件 = 未分配的 hunks，changelist 下的文件 = 该 changelist 的 hunks。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { ChangeDetector } from './changeDetector';
import type { ChangelistStore } from './changelistStore';
import {
  buildFilePatch,
  commitChangelist,
  commitUnassigned,
  discardChangelist,
  discardUnassigned,
  discardViewChanges,
  stageChangelist,
  stageRecords,
  stageUnassigned,
} from './commitEngine';
import type { GitService } from './gitService';
import { createHeadUri } from './headFsProvider';
import type { StoredHunk } from './matching';
import type { TreeNode } from './treeView';
import { t } from './i18n';

export interface CommandDeps {
  detector: ChangeDetector;
  store: ChangelistStore;
  git: GitService;
  output: vscode.OutputChannel;
  refreshAll: () => Promise<void>;
  /** 当前活动仓库（活动编辑器所在仓库，否则第一个） */
  activeRepo: () => Promise<{ repoRoot: string } | undefined>;
  /** 登记新创建的合成临时文件（diff 视图关闭时由扩展层自动清理） */
  trackTempFile: (path: string) => void;
}

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const register = (id: string, fn: (...args: any[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  register('changelistsPlus.refresh', () => deps.refreshAll());

  /**
   * 点击文件节点：打开只含该视图（Unassigned / 某 changelist）修改的 diff。
   * 右侧 = HEAD 内容 + 该视图的 hunks（合成临时文件），左侧 = HEAD。
   */
  register('changelistsPlus.diffFileInView', async (repoRoot: string, relPath: string, view: string) => {
    const left = createHeadUri(repoRoot, relPath);
    const built =
      view === 'unassigned'
        ? await buildFilePatch(deps.git, deps.store, repoRoot, relPath, (o) => o === null)
        : await buildFilePatch(deps.git, deps.store, repoRoot, relPath, (o) => o === view);
    let right: vscode.Uri = vscode.Uri.file(path.join(repoRoot, relPath));
    if (built) {
      // variant = 视图标识：同一文件在多个视图下的 diff 可同时打开互不覆盖
      const tmp = await deps.git.applyPatchToTempFile(repoRoot, relPath, built.patch, view);
      if (tmp) {
        right = vscode.Uri.file(tmp);
        deps.trackTempFile(tmp);
      }
    }
    // 标题带视图名（default / changelist 名），多个 diff 标签页能区分
    const viewName =
      view === 'unassigned'
        ? t('unassigned')
        : deps.store.changelistsOf(repoRoot).find((c) => c.id === view)?.name ?? view;
    void vscode.commands.executeCommand('vscode.diff', left, right, t('diffTitle', relPath, viewName));
  });

  /**
   * 打开工作区原文件（文件行末尾的行内图标）。
   */
  register('changelistsPlus.openFile', async (node?: TreeNode) => {
    const n = nodesOf(node, []).find((x) => x.kind === 'file');
    if (!n) {
      return;
    }
    void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(n.repoRoot, n.filePath)));
  });

  /**
   * 撤销当前视图（Unassigned / 该 changelist）下这个文件的所有修改，
   * 其他视图的修改不受影响。破坏性操作，先确认。
   */
  register('changelistsPlus.discardFile', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const n = nodesOf(node, []).find((x) => x.kind === 'file');
    if (!n) {
      return;
    }
    const view = n.contextValue === 'unassignedFile' ? 'unassigned' : n.changelistId;
    if (!view) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      t('discardConfirm', n.filePath),
      { modal: true },
      t('discardConfirmAction'),
    );
    if (choice !== t('discardConfirmAction')) {
      return;
    }
    const result = await discardViewChanges(deps.git, deps.store, n.repoRoot, n.filePath, view);
    if (result.ok) {
      vscode.window.showInformationMessage(t('discardSuccess', result.count));
    } else {
      if (result.stderr) {
        deps.output.appendLine(result.stderr);
      }
      vscode.window.showErrorMessage(t(result.error === 'empty' ? 'noAssignableHunks' : errorText(result.error)));
    }
    await deps.refreshAll();
  });

  register('changelistsPlus.newChangelist', async () => {
    if (!ensureTrusted()) {
      return;
    }
    const repo = await deps.activeRepo();
    if (!repo) {
      vscode.window.showInformationMessage(t('noGitRepo'));
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: t('changelistNamePrompt'),
      placeHolder: t('changelistNamePlaceholder'),
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    if (!name.trim()) {
      vscode.window.showWarningMessage(t('emptyName'));
      return;
    }
    deps.store.createChangelist(repo.repoRoot, name.trim());
  });

  register('changelistsPlus.renameChangelist', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const cl = findChangelist(deps, node);
    if (!cl) {
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: t('renamePrompt'),
      value: cl.name,
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    if (!name.trim()) {
      vscode.window.showWarningMessage(t('emptyName'));
      return;
    }
    deps.store.renameChangelist(cl.repoRoot, cl.id, name.trim());
  });

  register('changelistsPlus.deleteChangelist', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const cl = findChangelist(deps, node);
    if (!cl) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      t('deleteConfirm', cl.name),
      { modal: true },
      t('deleteConfirmAction'),
    );
    if (choice !== t('deleteConfirmAction')) {
      return;
    }
    deps.store.deleteChangelist(cl.repoRoot, cl.id);
  });

  register('changelistsPlus.commitChangelist', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const cl = findChangelist(deps, node);
    if (!cl) {
      return;
    }
    const message = await vscode.window.showInputBox({
      prompt: t('commitMessagePrompt'),
      placeHolder: t('commitMessagePlaceholder'),
      value: cl.name,
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    if (!message.trim()) {
      vscode.window.showWarningMessage(t('emptyMessage'));
      return;
    }
    const result = await commitChangelist({
      git: deps.git,
      store: deps.store,
      repoRoot: cl.repoRoot,
      changelistId: cl.id,
      message: message.trim(),
    });
    if (result.ok) {
      if (result.warning) {
        vscode.window.showWarningMessage(t('stagedRestoreFailed'));
      } else {
        vscode.window.showInformationMessage(t('commitSuccess', message.trim()));
      }
    } else {
      if (result.stderr) {
        deps.output.appendLine(`[${cl.name}] ${result.stderr}`);
      }
      vscode.window.showErrorMessage(t(errorText(result.error)));
    }
    await deps.refreshAll();
  });

  /** default（未分配）节点：提交其下全部改动 */
  register('changelistsPlus.commitUnassigned', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const repo = findRepo(deps, node);
    if (!repo) {
      return;
    }
    const message = await vscode.window.showInputBox({
      prompt: t('commitMessagePrompt'),
      placeHolder: t('commitMessagePlaceholder'),
      value: 'default',
      ignoreFocusOut: true,
    });
    if (message === undefined) {
      return;
    }
    if (!message.trim()) {
      vscode.window.showWarningMessage(t('emptyMessage'));
      return;
    }
    const result = await commitUnassigned({
      git: deps.git,
      store: deps.store,
      repoRoot: repo.repoRoot,
      message: message.trim(),
    });
    if (result.ok) {
      if (result.warning) {
        vscode.window.showWarningMessage(t('stagedRestoreFailed'));
      } else {
        vscode.window.showInformationMessage(t('commitSuccess', message.trim()));
      }
    } else {
      if (result.stderr) {
        deps.output.appendLine(result.stderr);
      }
      vscode.window.showErrorMessage(t(errorText(result.error)));
    }
    await deps.refreshAll();
  });

  /** default（未分配）节点：暂存其下全部改动 */
  register('changelistsPlus.stageUnassigned', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const repo = findRepo(deps, node);
    if (!repo) {
      return;
    }
    const result = await stageUnassigned(deps.git, deps.store, repo.repoRoot);
    if (result.ok) {
      vscode.window.showInformationMessage(
        result.stagedCount === 0 ? t('alreadyStaged') : t('stageSuccess', result.stagedCount),
      );
    } else {
      if (result.stderr) {
        deps.output.appendLine(result.stderr);
      }
      vscode.window.showErrorMessage(t(result.error === 'empty' ? 'noAssignableHunks' : errorText(result.error)));
    }
    await deps.refreshAll();
  });

  /** default（未分配）节点：撤销其下全部修改（其他视图的修改不受影响） */
  register('changelistsPlus.discardUnassigned', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const repo = findRepo(deps, node);
    if (!repo) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      t('discardUnassignedConfirm'),
      { modal: true },
      t('discardConfirmAction'),
    );
    if (choice !== t('discardConfirmAction')) {
      return;
    }
    const result = await discardUnassigned(deps.git, deps.store, repo.repoRoot);
    if (result.ok) {
      vscode.window.showInformationMessage(t('discardSuccess', result.count));
    } else {
      if (result.stderr) {
        deps.output.appendLine(result.stderr);
      }
      vscode.window.showErrorMessage(t(result.error === 'empty' ? 'noAssignableHunks' : errorText(result.error)));
    }
    await deps.refreshAll();
  });

  /** changelist 节点：撤销其下全部修改（其他视图的修改不受影响） */
  register('changelistsPlus.discardChangelist', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const cl = findChangelist(deps, node);
    if (!cl) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      t('discardChangelistConfirm', cl.name),
      { modal: true },
      t('discardConfirmAction'),
    );
    if (choice !== t('discardConfirmAction')) {
      return;
    }
    const result = await discardChangelist(deps.git, deps.store, cl.repoRoot, cl.id);
    if (result.ok) {
      vscode.window.showInformationMessage(t('discardSuccess', result.count));
    } else {
      if (result.stderr) {
        deps.output.appendLine(`[${cl.name}] ${result.stderr}`);
      }
      vscode.window.showErrorMessage(t(result.error === 'empty' ? 'noAssignableHunks' : errorText(result.error)));
    }
    await deps.refreshAll();
  });

  register('changelistsPlus.stageChangelist', async (node?: TreeNode) => {
    if (!ensureTrusted()) {
      return;
    }
    const cl = findChangelist(deps, node);
    if (!cl) {
      return;
    }
    const result = await stageChangelist({
      git: deps.git,
      store: deps.store,
      repoRoot: cl.repoRoot,
      changelistId: cl.id,
    });
    if (result.ok) {
      vscode.window.showInformationMessage(
        result.stagedCount === 0 ? t('alreadyStaged') : t('stageSuccess', result.stagedCount),
      );
    } else {
      if (result.stderr) {
        deps.output.appendLine(`[${cl.name}] ${result.stderr}`);
      }
      vscode.window.showErrorMessage(t(result.error === 'empty' ? 'noAssignableHunks' : errorText(result.error)));
    }
    await deps.refreshAll();
  });

  register('changelistsPlus.stageHunk', async (node?: TreeNode, ...others: TreeNode[]) => {
    if (!ensureTrusted()) {
      return;
    }
    const items = nodesOf(node, others).filter((n) => n.kind === 'file');
    if (items.length === 0) {
      return;
    }
    const records = collectViewRecords(deps, items);
    if (records.size === 0) {
      vscode.window.showInformationMessage(t('noAssignableHunks'));
      return;
    }
    let staged = 0;
    let failed = false;
    for (const [repoRoot, byPath] of records) {
      const result = await stageRecords(deps.git, repoRoot, byPath);
      if (result.ok) {
        staged += result.stagedCount;
      } else {
        failed = true;
        if (result.stderr) {
          deps.output.appendLine(result.stderr);
        }
        vscode.window.showErrorMessage(t(result.error === 'empty' ? 'noAssignableHunks' : errorText(result.error)));
      }
    }
    if (!failed) {
      vscode.window.showInformationMessage(
        staged === 0 ? t('alreadyStaged') : t('stageSuccess', staged),
      );
    }
    await deps.refreshAll();
  });

  register('changelistsPlus.moveToChangelist', async (node?: TreeNode, ...others: TreeNode[]) => {
    if (!ensureTrusted()) {
      return;
    }
    const items = nodesOf(node, others).filter((n) => n.kind === 'file');
    if (items.length === 0) {
      return;
    }
    const records = collectViewRecords(deps, items);
    if (records.size === 0) {
      vscode.window.showInformationMessage(t('noAssignableHunks'));
      return;
    }
    const targetId = await chooseTarget(deps, items[0].repoRoot);
    if (targetId === undefined) {
      return; // 用户取消
    }
    for (const [repoRoot, byPath] of records) {
      for (const [filePath, recs] of byPath) {
        deps.store.setHunkOwners(repoRoot, filePath, recs, targetId);
      }
    }
  });

  register('changelistsPlus.assignSelectionToChangelist', async () => {
    if (!ensureTrusted()) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (editor.document.isDirty) {
      vscode.window.showWarningMessage(t('saveFirst'));
      return;
    }
    const repoRoot = await deps.detector.resolveRepo(editor.document.uri.fsPath);
    if (!repoRoot) {
      vscode.window.showInformationMessage(t('noGitRepo'));
      return;
    }
    const rel = path.relative(repoRoot, editor.document.uri.fsPath).split(path.sep).join('/');
    const model = deps.detector.getModel(repoRoot);
    const fm = model?.files.find((f) => f.change.path === rel);
    if (!fm || fm.change.binary) {
      vscode.window.showInformationMessage(t('noChangeInSelection'));
      return;
    }
    const sel = editor.selection;
    const a = Math.min(sel.start.line, sel.end.line) + 1;
    const b = Math.max(sel.start.line, sel.end.line) + 1;
    const hits = fm.hunks.filter((h) => {
      if (h.hunk.newLines <= 0) {
        return false;
      }
      const hs = h.hunk.newStart;
      const he = h.hunk.newStart + h.hunk.newLines - 1;
      return hs <= b && he >= a;
    });
    if (hits.length === 0) {
      vscode.window.showInformationMessage(t('noChangeInSelection'));
      return;
    }
    const targetId = await chooseTarget(deps, repoRoot);
    if (targetId === undefined) {
      return;
    }
    const records: StoredHunk[] = hits.map((h) => ({
      id: h.hunk.id,
      oldStart: h.hunk.oldStart,
      oldLines: h.hunk.oldLines,
    }));
    deps.store.setHunkOwners(repoRoot, rel, records, targetId);
    vscode.window.showInformationMessage(t('assignSuccess', hits.length));
  });
}

interface LocatedChangelist {
  repoRoot: string;
  id: string;
  name: string;
}

function findChangelist(deps: CommandDeps, node?: TreeNode): LocatedChangelist | undefined {
  if (!node || !node.changelistId) {
    return undefined;
  }
  const cl = deps.store.changelistsOf(node.repoRoot).find((c) => c.id === node.changelistId);
  if (!cl) {
    return undefined;
  }
  return { repoRoot: node.repoRoot, id: cl.id, name: cl.name };
}

/** default（unassigned）节点定位仓库 */
function findRepo(deps: CommandDeps, node?: TreeNode): { repoRoot: string } | undefined {
  if (!node || !node.repoRoot) {
    return undefined;
  }
  if (node.kind !== 'unassigned') {
    return undefined;
  }
  return { repoRoot: node.repoRoot };
}

function nodesOf(node: unknown, others: unknown[]): TreeNode[] {
  const all = [node, ...others].filter(
    (n): n is TreeNode =>
      !!n && typeof n === 'object' && 'kind' in n && (n as TreeNode).kind !== 'message',
  );
  return all;
}

/**
 * 收集 (repoRoot, filePath) → records 的映射（move / stage 共用）。
 * 文件节点按所在视图收集 hunks：
 * - unassignedFile（Unassigned 下）→ 该文件未分配的 hunks
 * - file（changelist 下）→ 该文件属于该 changelist 的 hunks
 */
function collectViewRecords(
  deps: CommandDeps,
  nodes: TreeNode[],
): Map<string, Map<string, StoredHunk[]>> {
  const out = new Map<string, Map<string, StoredHunk[]>>();
  const add = (repoRoot: string, filePath: string, recs: StoredHunk[]): void => {
    if (recs.length === 0) {
      return;
    }
    let byPath = out.get(repoRoot);
    if (!byPath) {
      byPath = new Map();
      out.set(repoRoot, byPath);
    }
    byPath.set(filePath, recs);
  };
  for (const n of nodes) {
    if (n.kind !== 'file') {
      continue;
    }
    const model = deps.detector.getModel(n.repoRoot);
    const f = model?.files.find((fm) => fm.change.path === n.filePath);
    if (!f) {
      continue;
    }
    const filtered = f.hunks.filter((h) =>
      n.contextValue === 'unassignedFile' ? h.ownerId === null : h.ownerId === n.changelistId,
    );
    add(
      n.repoRoot,
      n.filePath,
      filtered.map((h) => ({ id: h.hunk.id, oldStart: h.hunk.oldStart, oldLines: h.hunk.oldLines })),
    );
  }
  return out;
}

/** QuickPick：选择目标 changelist（含"未分配"与"新建 changelist"选项） */
async function chooseTarget(
  deps: CommandDeps,
  repoRoot: string,
): Promise<string | null | undefined> {
  const unassignedItem: vscode.QuickPickItem = { label: t('moveToUnassigned') };
  const clItems: vscode.QuickPickItem[] = deps.store.changelistsOf(repoRoot).map((c) => ({
    label: c.name,
  }));
  const newItem: vscode.QuickPickItem = { label: t('newChangelistOption') };
  const pick = await vscode.window.showQuickPick(
    [unassignedItem, ...clItems, newItem],
    { placeHolder: t('chooseTarget'), ignoreFocusOut: true },
  );
  if (!pick) {
    return undefined;
  }
  if (pick === unassignedItem) {
    return null;
  }
  if (pick === newItem) {
    const name = await vscode.window.showInputBox({
      prompt: t('changelistNamePrompt'),
      placeHolder: t('changelistNamePlaceholder'),
      ignoreFocusOut: true,
    });
    if (name === undefined || !name.trim()) {
      return undefined;
    }
    const cl = deps.store.createChangelist(repoRoot, name.trim());
    return cl.id;
  }
  const idx = clItems.indexOf(pick);
  return deps.store.changelistsOf(repoRoot)[idx]?.id ?? undefined;
}

function errorText(err: string): string {
  switch (err) {
    case 'mergeInProgress':
      return 'mergeInProgress';
    case 'unmerged':
      return 'unmergedFiles';
    case 'noHead':
      return 'noHead';
    case 'empty':
    case 'noSuchChangelist':
      return 'emptyChangelist';
    case 'emptyMessage':
      return 'emptyMessage';
    case 'applyFailed':
      return 'applyFailed';
    case 'commitFailed':
      return 'commitFailed';
    default:
      return err;
  }
}

function ensureTrusted(): boolean {
  if (vscode.workspace.isTrusted) {
    return true;
  }
  vscode.window.showWarningMessage(t('workspaceUntrusted'));
  return false;
}
