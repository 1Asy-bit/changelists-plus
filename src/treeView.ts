/**
 * "Changelists Plus" 树视图（挂在 Source Control 面板的 scm 容器下）。
 * 参考 IDEA 的文件级 changelist：树只到文件层（不展开 hunk），
 * 同一文件按归属可同时出现在 Unassigned 与多个 Changelist 下——
 * 各处的文件节点只代表「该视图（Unassigned / 某 changelist）下的修改」：
 * - 点击文件 → 打开只含该视图修改的 diff（HEAD vs HEAD+该视图 hunks 合成内容）
 * - 拖拽文件 → 移动该视图下的 hunks 到目标 changelist
 * - 再次编辑后新增的 hunks 自动归属 null → 文件重新出现在 Unassigned
 */
import * as vscode from 'vscode';
import * as path from 'path';
import type { ChangeDetector, FileModel, RepoModel } from './changeDetector';
import type { ChangelistStore } from './changelistStore';
import type { Hunk } from './diffParser';
import { t } from './i18n';

const DRAG_MIME = 'application/vnd.code.tree.changelistsplus';

/** 文件节点所在的视图上下文：'unassigned' 或 changelist id */
export type FileView = string | 'unassigned';

export type NodeKind =
  | 'message'
  | 'unassigned'
  | 'changelist'
  | 'file'
  | 'repo';

export class TreeNode {
  constructor(
    public readonly kind: NodeKind,
    public readonly label: string,
    public readonly collapsible: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly description = '',
    public readonly icon = '',
    public readonly repoRoot = '',
    public readonly filePath = '',
    public readonly hunk: Hunk | undefined = undefined,
    public readonly changelistId: string | undefined = undefined,
    public readonly tooltip = '',
  ) {}
}

export class ChangelistTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(
    private detector: ChangeDetector,
    private store: ChangelistStore,
  ) {}

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, node.collapsible);
    item.contextValue = node.contextValue;
    item.description = node.description || undefined;
    item.tooltip = node.tooltip || undefined;
    item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
    if (node.kind === 'file' && node.repoRoot && node.filePath) {
      // 点击文件 → 打开只含该视图修改的 diff（命令内异步合成右侧内容）
      item.command = {
        command: 'changelistsPlus.diffFileInView',
        title: '',
        arguments: [
          node.repoRoot,
          node.filePath,
          node.contextValue === 'unassignedFile' ? 'unassigned' : node.changelistId ?? 'unassigned',
        ],
      };
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.rootNodes();
    }
    switch (node.kind) {
      case 'repo':
        return this.repoNodes(this.detector.getModel(node.repoRoot));
      case 'unassigned':
        return this.filesFor(node.repoRoot, (f) => f.hunks.some((h) => h.ownerId === null), null);
      case 'changelist':
        return this.filesFor(node.repoRoot, (f) => f.hunks.some((h) => h.ownerId === node.changelistId), node.changelistId);
      default:
        return [];
    }
  }

  private rootNodes(): TreeNode[] {
    const repos = this.detector.snapshot();
    if (repos.length === 0) {
      return [
        new TreeNode('message', t('noGitRepo'), vscode.TreeItemCollapsibleState.None, 'message', '', 'info'),
      ];
    }
    if (repos.length === 1) {
      return this.repoNodes(repos[0]);
    }
    return repos.map(
      (r) =>
        new TreeNode(
          'repo',
          path.basename(r.repoRoot),
          vscode.TreeItemCollapsibleState.Expanded,
          'repo',
          r.repoRoot,
          'repo',
          r.repoRoot,
        ),
    );
  }

  private repoNodes(model: RepoModel | undefined): TreeNode[] {
    if (!model) {
      return [];
    }
    const nodes: TreeNode[] = [];
    if (!model.headExists) {
      nodes.push(
        new TreeNode('message', t('noHeadInfo'), vscode.TreeItemCollapsibleState.None, 'message', '', 'info'),
      );
    }
    const unassigned = new TreeNode(
      'unassigned',
      t('unassigned'),
      vscode.TreeItemCollapsibleState.Expanded,
      'unassigned',
      String(model.unassignedHunkCount),
      'inbox',
      model.repoRoot,
    );
    nodes.push(unassigned);
    for (const cl of model.changelists) {
      const desc = t('fileCount', cl.fileCount);
      nodes.push(
        new TreeNode(
          'changelist',
          cl.name,
          vscode.TreeItemCollapsibleState.Expanded,
          'changelist',
          desc,
          'list-unordered',
          model.repoRoot,
          '',
          undefined,
          cl.id,
        ),
      );
    }
    return nodes;
  }

  private filesFor(
    repoRoot: string,
    predicate: (f: FileModel) => boolean,
    changelistId: string | null | undefined,
  ): TreeNode[] {
    const model = this.detector.getModel(repoRoot);
    if (!model) {
      return [];
    }
    return model.files
      .filter(predicate)
      .map((f) => this.fileNode(repoRoot, f, changelistId ?? undefined));
  }

  private fileNode(repoRoot: string, f: FileModel, changelistId: string | undefined): TreeNode {
    const isUnassignedOwner = changelistId === undefined;
    const base = path.basename(f.change.path);
    const dir = path.dirname(f.change.path);
    const kindDesc =
      f.change.kind === 'new' ? t('newFile') : f.change.kind === 'deleted' ? t('deletedFile') : '';
    // 该视图（Unassigned / 某 changelist）下这个文件的修改数——体现"两次不同的修改"
    const viewHunks = f.hunks.filter((h) =>
      isUnassignedOwner ? h.ownerId === null : h.ownerId === changelistId,
    );
    const desc = [
      dir && dir !== '.' ? dir : '',
      f.change.binary ? t('binaryFile') : '',
      kindDesc,
      t('hunkCount', viewHunks.length),
    ]
      .filter(Boolean)
      .join(' · ');
    return new TreeNode(
      'file',
      base,
      vscode.TreeItemCollapsibleState.None,
      isUnassignedOwner ? 'unassignedFile' : 'file',
      desc,
      f.change.binary ? 'file-binary' : 'file',
      repoRoot,
      f.change.path,
      undefined,
      changelistId,
      f.change.path,
    );
  }
}

/** 拖拽：把文件拖到 changelist 节点（或空白处 = 未分配）；按视图语义移动 hunks */
export class ChangelistDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [DRAG_MIME];
  readonly dropMimeTypes = [DRAG_MIME];

  constructor(
    private detector: ChangeDetector,
    private store: ChangelistStore,
    private onAssign: () => void,
  ) {}

  handleDrag(source: readonly TreeNode[], dataTransfer: vscode.DataTransfer): void {
    const payloads = source
      .filter((n) => n.kind === 'file')
      .map((n) => ({
        repoRoot: n.repoRoot,
        filePath: n.filePath,
        // 拖的是哪个视图下的文件 → 只移动该视图的 hunks
        view: n.contextValue === 'unassignedFile' ? ('unassigned' as const) : (n.changelistId ?? ('unassigned' as const)),
      }));
    if (payloads.length > 0) {
      dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(payloads)));
    }
  }

  getDragURI(node: TreeNode): vscode.Uri | undefined {
    if (node.kind === 'file' && node.repoRoot) {
      return vscode.Uri.file(path.join(node.repoRoot, node.filePath));
    }
    return undefined;
  }

  async handleDrop(target: TreeNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const item = dataTransfer.get(DRAG_MIME);
    if (!item) {
      return;
    }
    let targetId: string | null;
    if (target && target.kind === 'changelist') {
      targetId = target.changelistId ?? null;
    } else if (!target || target.kind === 'unassigned') {
      targetId = null;
    } else {
      return;
    }
    const payloads = JSON.parse(String(item.value)) as Array<{
      repoRoot: string;
      filePath: string;
      view: string;
    }>;
    for (const p of payloads) {
      const model = this.detector.getModel(p.repoRoot);
      const f = model?.files.find((fm) => fm.change.path === p.filePath);
      const records = f
        ? f.hunks
            .filter((h) => (p.view === 'unassigned' ? h.ownerId === null : h.ownerId === p.view))
            .map((h) => ({ id: h.hunk.id, oldStart: h.hunk.oldStart, oldLines: h.hunk.oldLines }))
        : [];
      if (records.length > 0) {
        this.store.setHunkOwners(p.repoRoot, p.filePath, records, targetId);
      }
    }
    this.onAssign();
  }
}
