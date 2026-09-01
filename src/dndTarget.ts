/**
 * 拖放目标解析：树节点 → 目标 changelist id。
 * 独立模块（无 vscode 依赖）：treeView.ts 与 node 测试共用。
 */

/**
 * 拖放目标 → 目标 changelist id。返回 null 表示 default（未分配），
 * undefined 表示该目标不可放置（拖放应被忽略）。
 *
 * VS Code 的 drop 目标是鼠标下最深的节点：用户把文件拖到 default / changelist
 * 区块内时，松手点常落在区块内的文件行上而非节点行本身——文件行解析为其所在
 * 视图（拖到 default 下的文件上 = 移入 default，拖到 changelist 下的文件上 =
 * 移入该 changelist，与拖到对应节点行等价）；repo 行 = 该仓库的 default。
 */
export function resolveDropTargetId(
  target:
    | { kind: string; contextValue: string; label?: string; changelistId?: string }
    | undefined,
): { id: string | null; name: string } | undefined {
  if (!target || target.kind === 'unassigned') {
    return { id: null, name: '' };
  }
  if (target.kind === 'changelist') {
    return { id: target.changelistId ?? null, name: target.label ?? '' };
  }
  if (target.kind === 'file') {
    return {
      id: target.contextValue === 'unassignedFile' ? null : (target.changelistId ?? null),
      name: '',
    };
  }
  if (target.kind === 'repo') {
    return { id: null, name: '' };
  }
  return undefined;
}
