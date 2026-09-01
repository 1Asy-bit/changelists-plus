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
import { ChangeDetector, FileModel, RepoModel, StageState, stageStateOf, combineStageStates } from './changeDetector';
import type { ChangelistStore } from './changelistStore';
import type { Hunk } from './diffParser';
import { resolveDropTargetId } from './dndTarget';
import { t } from './i18n';

const DRAG_MIME = 'application/vnd.code.tree.changelistsplus';

/** 暂存状态圆点：changelist / default / 文件行的图标（替代原来的 codicon 图标） */
const STAGE_ICON = 'circle-filled';
/** 三态 → 主题色 key（VS Code SCM 惯例：绿=已暂存、橙=修改；灰用核心主题色 disabledForeground） */
const STAGE_COLOR: Record<StageState, string> = {
  all: 'gitDecoration.addedResourceForeground',
  partial: 'gitDecoration.modifiedResourceForeground',
  none: 'disabledForeground',
};

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
    /** 主题色 key；非空时 icon 用 ThemeIcon(icon, ThemeColor(iconColor)) */
    public readonly iconColor = '',
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
    item.iconPath = node.icon
      ? new vscode.ThemeIcon(node.icon, node.iconColor ? new vscode.ThemeColor(node.iconColor) : undefined)
      : undefined;
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

  /**
   * 单遍扫描每个文件的暂存状态，按归属聚合（key：'null' = unassigned / changelist id）。
   * 每个文件只扫一次，避免 O(changelist 数 × 文件数) 嵌套。
   */
  private stageStatesByOwner(model: RepoModel): Map<string, StageState[]> {
    const byOwner = new Map<string, StageState[]>();
    for (const f of model.files) {
      const staged = this.detector.stagedIds(model.repoRoot, f.change.path);
      const owners = new Set(f.hunks.map((h) => h.ownerId ?? 'null'));
      for (const owner of owners) {
        const ids = f.hunks.filter((h) => (h.ownerId ?? 'null') === owner).map((h) => h.hunk.id);
        const list = byOwner.get(owner) ?? [];
        list.push(stageStateOf(ids, staged));
        byOwner.set(owner, list);
      }
    }
    return byOwner;
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
    const byOwner = this.stageStatesByOwner(model);
    const unassignedState = combineStageStates(byOwner.get('null') ?? []);
    const unassigned = new TreeNode(
      'unassigned',
      t('unassigned'),
      vscode.TreeItemCollapsibleState.Expanded,
      'unassigned',
      String(model.unassignedHunkCount),
      STAGE_ICON,
      model.repoRoot,
      '',
      undefined,
      undefined,
      '',
      STAGE_COLOR[unassignedState],
    );
    nodes.push(unassigned);
    for (const cl of model.changelists) {
      const desc = t('fileCount', cl.fileCount);
      const state = combineStageStates(byOwner.get(cl.id) ?? []);
      nodes.push(
        new TreeNode(
          'changelist',
          cl.name,
          vscode.TreeItemCollapsibleState.Expanded,
          'changelist',
          desc,
          STAGE_ICON,
          model.repoRoot,
          '',
          undefined,
          cl.id,
          '',
          STAGE_COLOR[state],
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
    // 圆点颜色 = 该视图下 hunks 的暂存状态（binary 无 hunks，保留原图标作防御）
    const stageState = stageStateOf(
      viewHunks.map((h) => h.hunk.id),
      this.detector.stagedIds(repoRoot, f.change.path),
    );
    return new TreeNode(
      'file',
      base,
      vscode.TreeItemCollapsibleState.None,
      isUnassignedOwner ? 'unassignedFile' : 'file',
      desc,
      f.change.binary ? 'file-binary' : STAGE_ICON,
      repoRoot,
      f.change.path,
      undefined,
      changelistId,
      f.change.path,
      f.change.binary ? '' : STAGE_COLOR[stageState],
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
    const resolved = resolveDropTargetId(target);
    if (!resolved) {
      return;
    }
    const { id: targetId, name: targetName } = resolved;
    const payloads = JSON.parse(String(item.value)) as Array<{
      repoRoot: string;
      filePath: string;
      view: string;
    }>;
    for (const p of payloads) {
      // 跨仓库拖拽：changelist 按仓库存储，目标 id 在其他仓库不存在时
      // 自动创建同名 changelist（IDEA 式行为），避免写入"幽灵 changelist id"孤儿数据
      let id = targetId;
      if (id !== null && !this.store.changelistsOf(p.repoRoot).some((c) => c.id === id)) {
        id = this.store.createChangelist(p.repoRoot, targetName).id;
      }
      const model = this.detector.getModel(p.repoRoot);
      const f = model?.files.find((fm) => fm.change.path === p.filePath);
      const records = f
        ? f.hunks
            .filter((h) => (p.view === 'unassigned' ? h.ownerId === null : h.ownerId === p.view))
            .map((h) => ({ id: h.hunk.id, oldStart: h.hunk.oldStart, oldLines: h.hunk.oldLines }))
        : [];
      if (records.length > 0) {
        this.store.setHunkOwners(p.repoRoot, p.filePath, records, id);
      }
    }
    this.onAssign();
  }
}
