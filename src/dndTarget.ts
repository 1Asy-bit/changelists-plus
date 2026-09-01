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

/**
 * changelist 排序目标解析：返回 afterId（被拖的 changelist 排到 afterId 之后；
 * null = 排到列表首位）。undefined = 该目标不可放置（忽略）。
 *
 * 语义：拖 A 到 changelist B 上 = A 排到 B 之后；拖到 default / repo 行 / 树空白 =
 * 排到首位（default 渲染在 changelist 列表之前，其"之后"正是列表首位）；
 * 拖到文件行上 = 其所在视图（default 下 → 首位，changelist 下 → 该 changelist 之后）。
 */
export function resolveReorderAfterId(
  target:
    | { kind: string; contextValue: string; changelistId?: string }
    | undefined,
): string | null | undefined {
  if (!target || target.kind === 'unassigned' || target.kind === 'repo') {
    return null;
  }
  if (target.kind === 'changelist') {
    return target.changelistId ?? null;
  }
  if (target.kind === 'file') {
    return target.contextValue === 'unassignedFile' ? null : (target.changelistId ?? null);
  }
  return undefined;
}
