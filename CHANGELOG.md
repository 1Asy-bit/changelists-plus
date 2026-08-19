# Changelog

All notable changes to Changelists Plus are documented here.

[English](#english) · [中文](#中文)

---

## English

### 0.2.11

- **Refresh sync fix**: full refresh and per-file refresh now use independent version counters — clicking refresh can no longer be dropped by a concurrent save-triggered refresh, and multiple files changed at once (terminal batch writes) all get synced
- **External edits sync**: a workspace file watcher now picks up changes written directly to disk (terminal / external tools), no editor re-save needed
- **Performance**:
  - Batch file changes debounce into a single refresh pass (large batches drop from 2 git processes per file to 4 in total)
  - Full refresh no longer rebuilds the tree view twice
  - refreshAll reuses cached repository roots

### 0.2.10

- Updated extension icon (new design)

### 0.2.9

- **Staged-state dots**: changelist / file / `default` rows now show a status dot — green = fully staged, orange = partially staged, grey = nothing staged (theme-colored, matching Git decorations)
- **Staging & discard fixes**:
  - Insertion hunks are re-anchored when staging partial selections (unstaged insertions above no longer shift them)
  - Failed 3-way merges clean up conflicted index paths (`git reset` for affected paths only)
  - Staged-state restore after commit skips already-committed hunks and new files edited after staging (warns if something could not be restored)
  - Discard warns when the index could not be fully synced
- **Robustness**: same-id multi-hunk matching, version-guarded refreshes, real-path normalization for symlinked roots, target-repo prompt on cross-repo drag & drop, git-dir-aware file watching, Windows path fixes

### 0.2.8

- Repository metadata (`repository` / `bugs` / `homepage`) added to the manifest for marketplace listing
- Publisher id: `1Asy-bit` (extension id: `1Asy-bit.changelists-plus`)

### 0.2.7

- **Discard a changelist**: new "Discard Changes" action on changelist rows (right-click + inline icon, before Delete) — undoes all changes assigned to that changelist; other changelists and `default` stay untouched

### 0.2.6

- **Marketplace-ready packaging**: bilingual README (English / 简体中文), CHANGELOG.md, search keywords, and gallery banner added for marketplace listing
- **Windows hardening**: repository lookup now compares paths case-insensitively (drive-letter / directory case differences on case-insensitive filesystems no longer cause refresh misses)

### 0.2.5

- **Idempotent re-staging**: staging already-staged changes (changelist, files, or hunks) is now a safe no-op with an "already staged" notice instead of an apply failure
- **Discard syncs the index**: discarding a view's changes also unstages the same hunks from the index when applicable
- **Fixes**:
  - File names containing `* ? [` are now treated literally (previously interpreted as git pathspec globs, which could make the file disappear from the view after refresh)
  - Per-repo isolation of diff-view temp files (multi-repo workspaces no longer share files)
  - Committing from `default` with pre-existing staged changes now preserves the staged state correctly
- **Tests**: 41 passing (zero-dependency, real git repositories)

### 0.2.4

- View renamed from "Smart Changelists" to "Changelists"

### 0.2.3

- Unassigned changes node renamed to **default**
- Batch operations on `default`: commit / stage / discard all unassigned changes (right-click + inline icons)

### 0.2.2

- Inline action icons on every changelist row: commit / stage / delete

### 0.2.1

- Inline action icons on every file row: open file / discard this view's changes / stage this view's changes
- Extension icon (marketplace, title bar)

### 0.2.0

- IDEA-style file-level view: files are listed per changelist with change counts instead of expanded hunks
- Per-view diff: clicking a file opens "HEAD ⟷ HEAD + this view's changes" comparison
- Stage support: stage a changelist or selected hunks to the index without touching the working tree
- Discard support: undo changes of one view only, other views stay
- Drag & drop and multi-select assignment

---

## 中文

### 0.2.11

- **刷新同步修复**：全量刷新与单文件刷新改用独立的版本号，互不作废——点击刷新不再被并发的保存刷新丢弃，终端批量写入的多个文件也会全部同步
- **外部修改同步**：新增工作区文件监听——终端 / 外部工具直接写入磁盘的改动，无需在编辑器内重新保存即可同步到视图
- **性能优化**：
  - 批量文件变化合并为一次刷新（大批量时 git 进程数从每文件 2 个降为总共 4 个）
  - 全量刷新不再重复重建两遍视图树
  - refreshAll 复用已缓存的仓库根路径

### 0.2.10

- 更新扩展图标（新设计）

### 0.2.9

- **暂存状态圆点**：changelist / 文件 / `default` 行现在显示状态圆点——绿 = 全部已暂存，橙 = 部分已暂存，灰 = 未暂存（使用主题色，与 Git 装饰一致）
- **暂存与撤销修复**：
  - 暂存部分选区时，插入型 hunk 重新锚定（上方未暂存的插入不再使其错位）
  - 3-way 合并失败后清理暂存区的冲突路径（仅对受影响路径执行 `git reset`）
  - 提交后恢复暂存状态时跳过已提交的 hunk，以及暂存后又编辑过的新文件（无法恢复时给出警告）
  - 撤销改动时若暂存区未能完全同步，会给出警告而非静默偏离
- **健壮性**：同 id 多 hunk 匹配、刷新版本号防覆盖、符号链接根目录 realpath 归一、跨仓库拖放时选择目标仓库、文件监听跟随真实 git-dir、Windows 路径修复

### 0.2.8

- 清单加入仓库元数据（`repository` / `bugs` / `homepage`），用于应用市场展示
- 发布者 id：`1Asy-bit`（扩展 id：`1Asy-bit.changelists-plus`）

### 0.2.7

- **撤销 Changelist**：Changelist 行新增「撤销改动」操作（右键 + 行内图标，位于删除之前）——撤销该 Changelist 下的全部改动；其他 Changelist 与 `default` 不受影响

### 0.2.6

- **应用市场就绪打包**：双语 README（英文 / 简体中文）、CHANGELOG.md、搜索关键词、gallery banner
- **Windows 加固**：仓库查找路径比较统一忽略大小写（大小写不敏感文件系统上的盘符 / 目录大小写差异不再导致刷新遗漏）

### 0.2.5

- **幂等重复暂存**：对已暂存的改动（Changelist、文件或 hunks）再次暂存是安全的无操作，并提示「已在暂存区」，不再报 apply 失败
- **撤销同步暂存区**：撤销某个视图的改动时，若适用会把同一批 hunks 从暂存区移除
- **修复**：
  - 文件名含 `* ? [` 时按字面处理（此前被当作 git pathspec 通配符，可能导致文件在刷新后从视图消失）
  - diff 视图临时文件按仓库隔离（多仓库工作区不再共用文件）
  - 从 `default` 提交时若暂存区已有其他改动，能正确保留暂存状态
- **测试**：41 个用例全部通过（零依赖、真实 git 仓库）

### 0.2.4

- 视图名称从 "Smart Changelists" 更名为 "Changelists"

### 0.2.3

- 未分配改动节点更名为 **default**
- default 批量操作：提交 / 暂存 / 撤销全部未分配改动（右键 + 行内图标）

### 0.2.2

- 每个 Changelist 行新增行内操作图标：提交 / 暂存 / 删除

### 0.2.1

- 每个文件行新增行内操作图标：打开文件 / 撤销该视图修改 / 暂存该视图修改
- 扩展图标（应用市场、标题栏）

### 0.2.0

- IDEA 风格文件级视图：文件按 Changelist 分组展示并带改动数，取代展开的 hunk 列表
- 按视图 diff：点击文件打开「HEAD ⟷ HEAD + 该视图改动」对比
- 暂存支持：把 Changelist 或选中 hunks 暂存到 index（`git apply --cached`），工作区不动
- 撤销支持：只撤销某个视图的改动，其他视图不受影响
- 拖拽与多选分配
