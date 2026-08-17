/**
 * 极简中英双语运行时文案。贡献点文案（命令名/视图名等）走 package.nls.json
 * + package.nls.zh-cn.json，由 VS Code 按显示语言加载；运行时文案由本模块处理。
 */
import * as vscode from 'vscode';

const zh: Record<string, string> = {
  viewName: 'Changelists',
  unassigned: 'default',
  noGitRepo: '当前工作区没有可用的 Git 仓库',
  noHeadInfo: '仓库还没有提交（空仓库）；仍可为未跟踪文件分配改动',
  refresh: '刷新',
  changelistNamePrompt: '输入新 Changelist 的名称',
  changelistNamePlaceholder: 'Changelist 名称',
  renamePrompt: '输入新的名称',
  emptyName: '名称不能为空',
  commitMessagePrompt: '输入提交信息',
  commitMessagePlaceholder: '提交信息…',
  emptyMessage: '提交信息不能为空',
  deleteConfirm: '删除 Changelist "{0}"？其下的改动将回到 default。',
  deleteConfirmAction: '删除',
  chooseTarget: '选择目标 Changelist',
  moveToUnassigned: 'default',
  newChangelistOption: '新建 Changelist…',
  saveFirst: '请先保存文件，再分配改动',
  noChangeInSelection: '选区没有命中任何改动',
  assignSuccess: '已分配 {0} 处改动',
  stageSuccess: '已暂存 {0} 处改动',
  alreadyStaged: '改动已在暂存区',
  mergeInProgress: '存在未完成的合并/变基/拣选操作，不能提交',
  unmergedFiles: '存在未解决的冲突文件，不能提交',
  noHead: '仓库还没有提交，无法提交 Changelist',
  emptyChangelist: '该 Changelist 当前没有可提交的改动',
  commitSuccess: '已提交：{0}',
  commitFailed: '提交失败',
  applyFailed: '改动已经变化，请刷新后重试',
  stagedRestoreFailed: '未能完整恢复暂存状态，暂存区已重置（工作区内容未受影响）',
  workspaceUntrusted: '工作区不受信任，操作已禁用',
  storageDirMissing: '当前窗口没有工作区文件夹，Changelists Plus 不可用',
  corruptStorage: '存储文件损坏，已备份为：{0}',
  binaryFile: '二进制文件',
  binaryNotSupported: '二进制文件暂不支持拆分提交',
  fileCount: '{0} 个文件',
  hunkCount: '{0} 处改动',
  assignedBadge: '{0} 处已分配改动',
  deletedFile: '已删除',
  newFile: '新文件',
  noAssignableHunks: '当前没有可分配的改动',
  commitAborted: '提交已中止：{0}',
  detail: '详情',
  modified: '已修改',
  diffTitle: '{0}（HEAD ⟷ 工作区 · {1}）',
  discardConfirm: '撤销 "{0}" 的修改？此操作会改写文件内容；其他视图的修改不受影响。',
  discardUnassignedConfirm: '撤销 default 下全部修改？此操作会改写文件内容；已分配到 Changelist 的修改不受影响。',
  discardChangelistConfirm: '撤销 Changelist "{0}" 下全部修改？此操作会改写文件内容；其他 Changelist 与 default 的修改不受影响。',
  discardConfirmAction: '撤销',
  discardSuccess: '已撤销 {0} 处修改',
};

const en: Record<string, string> = {
  viewName: 'Changelists',
  unassigned: 'default',
  noGitRepo: 'No Git repository available in this workspace',
  noHeadInfo: 'No commits yet (empty repository); untracked files can still be assigned',
  refresh: 'Refresh',
  changelistNamePrompt: 'Enter a name for the new changelist',
  changelistNamePlaceholder: 'Changelist name',
  renamePrompt: 'Enter a new name',
  emptyName: 'Name cannot be empty',
  commitMessagePrompt: 'Enter a commit message',
  commitMessagePlaceholder: 'Commit message…',
  emptyMessage: 'Commit message cannot be empty',
  deleteConfirm: 'Delete changelist "{0}"? Its changes will move back to default.',
  deleteConfirmAction: 'Delete',
  chooseTarget: 'Choose a target changelist',
  moveToUnassigned: 'default',
  newChangelistOption: 'New Changelist…',
  saveFirst: 'Save the file first, then assign changes',
  noChangeInSelection: 'The selection does not intersect any change',
  assignSuccess: 'Assigned {0} change(s)',
  stageSuccess: 'Staged {0} change(s)',
  alreadyStaged: 'Changes are already staged',
  mergeInProgress: 'A merge, rebase, or cherry-pick is in progress; cannot commit',
  unmergedFiles: 'There are unresolved conflicts; cannot commit',
  noHead: 'No commits yet; cannot commit a changelist',
  emptyChangelist: 'This changelist has no changes to commit',
  commitSuccess: 'Committed: {0}',
  commitFailed: 'Commit failed',
  applyFailed: 'The changes have changed; refresh and try again',
  stagedRestoreFailed: 'Could not fully restore the staged state; the index was reset (worktree untouched)',
  workspaceUntrusted: 'Workspace is not trusted; operation disabled',
  storageDirMissing: 'No workspace folder; Changelists Plus is unavailable',
  corruptStorage: 'Storage file was corrupt; backed up to: {0}',
  binaryFile: 'Binary file',
  binaryNotSupported: 'Binary files cannot be split yet',
  fileCount: '{0} files',
  hunkCount: '{0} change(s)',
  assignedBadge: '{0} assigned change(s)',
  deletedFile: 'Deleted',
  newFile: 'New file',
  noAssignableHunks: 'No assignable changes right now',
  commitAborted: 'Commit aborted: {0}',
  detail: 'Details',
  modified: 'Modified',
  diffTitle: '{0} (HEAD ⟷ Worktree · {1})',
  discardConfirm: 'Discard changes to "{0}"? This rewrites the file; changes in other views stay.',
  discardUnassignedConfirm: 'Discard all changes in default? This rewrites files; changes assigned to changelists stay.',
  discardChangelistConfirm: 'Discard all changes in changelist "{0}"? This rewrites files; changes in other changelists and default stay.',
  discardConfirmAction: 'Discard',
  discardSuccess: 'Discarded {0} change(s)',
};

let lang: 'zh' | 'en' = 'en';

export function initI18n(): void {
  lang = vscode.env.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function t(key: string, ...args: Array<string | number>): string {
  const dict = lang === 'zh' ? zh : en;
  let s = dict[key] ?? en[key] ?? key;
  args.forEach((a, i) => {
    s = s.split(`{${i}}`).join(String(a));
  });
  return s;
}
