# Changelists Plus

[English](#english) · [中文](#中文)

---

## English

Split the changes inside a single file across multiple changelists, then commit only one of them — everything else stays in your working tree, untouched.

### Features

- **Split one file's edits across changelists** — a file can appear under `default` and several changelists at the same time; new edits made after assigning automatically go back to `default`
- **Per-view diff** — click a file under a changelist to open a "HEAD ⟷ HEAD + this view's changes" comparison; you see exactly what that changelist changed
- **Partial commit** — commit only the selected changelist; the working tree is never rewritten and the remaining changes are preserved as-is
- **Stage** — stage a changelist, selected files, or selected hunks to the index (`git apply --cached`), without touching the working tree; re-staging already-staged changes is a safe no-op
- **Inline file actions** — every file row has three icon buttons: open the original file, discard this view's changes (with confirmation), stage this view's changes
- **Inline changelist actions** — every changelist row has four icon buttons: commit, stage, discard (with confirmation), delete
- **`default` node** — unassigned changes live under `default` (IDEA style); one-click commit / stage / discard for all unassigned changes
- **Works with plain `git add`** — changes you staged beforehand are preserved and filtered around each commit; if restoration is impossible the extension resets the index and tells you explicitly (your files are never affected)
- **New (untracked) files** — fully supported as whole-file hunks: assign, stage, and commit them
- **Safety guards** — refuses to commit during a merge / rebase / cherry-pick, with unresolved conflicts, or in an empty repository; a failing pre-commit hook leaves HEAD and the index untouched
- **Drag & drop** (VS Code 1.66+) and multi-select batch operations
- **Bilingual UI** — English and Simplified Chinese, follows the VS Code display language
- **Automatic refresh** — on file save and on `.git` changes (commit / branch switch)

### Quick Start

1. **Open the view** — open a folder containing a Git repository; the **Changelists** view appears at the bottom of the Source Control panel. All changes start under **default**, grouped by file.
2. **Assign changes** — either drag a file onto a changelist, or select the edited code in the editor, right-click and choose *Assign Selected Changes to Changelist…*. Edits you make afterwards go back to `default` and can be dragged to another changelist.
3. **Commit only one** — right-click a changelist → *Commit Changelist* → enter a message (the changelist name is pre-filled) → press Enter.
4. **Verify** — `git log -1 --stat` shows only that changelist's changes; `git diff HEAD` still shows the rest, still in your working tree.

### Commands

| Command | How to trigger | Description |
|---|---|---|
| New Changelist… | ＋ button in the view title bar | Create a changelist |
| Refresh | ⟳ button in the view title bar | Re-scan the repository |
| Commit Changelist… | right-click a changelist / ✔ inline icon | Commit only that changelist's changes |
| Stage Changelist | right-click a changelist / ＋ inline icon | Stage that changelist to the index (worktree untouched) |
| Discard Changes | right-click a changelist / ↺ inline icon | Discard all changes of that changelist (with confirmation; other views stay) |
| Delete Changelist | right-click a changelist / 🗑 inline icon | Delete it; its changes return to `default` |
| Commit Changes… | right-click `default` / ✔ inline icon | Commit all unassigned changes |
| Stage Changes | right-click `default` / ＋ inline icon | Stage all unassigned changes |
| Discard Changes | right-click `default` / ↺ inline icon | Discard all unassigned changes (with confirmation; assigned changes stay) |
| Open File | ⤴ inline icon on a file row | Open the original file in the worktree |
| Stage Change | right-click a file (multi-select supported) / ＋ inline icon | Stage this view's changes of the file |
| Discard Changes | ↺ inline icon on a file row | Discard this view's changes of the file (with confirmation; other views stay) |
| Rename Changelist | right-click a changelist | Rename it |
| Move to Changelist… | right-click a file (multi-select supported) | Move this view's changes; target can be a changelist or `default` |
| Assign Selected Changes to Changelist… | editor right-click on a selection | Assign the selected changes to a changelist |

### Configuration

| Setting | Default | Description |
|---|---|---|
| `changelistsPlus.gitPath` | `git` | Path to the git executable (for non-standard installs) |
| `changelistsPlus.contextLines` | `3` | Diff context lines; larger values merge nearby edits into a single hunk |

### Requirements

- VS Code **^1.85.0**
- Git available on `PATH` (or configured via `changelistsPlus.gitPath`)

### Privacy & Data

Everything stays **local**. Changelist data is stored under VS Code's workspace storage, keyed per repository root (atomic writes, automatic corruption backup). No network access, no telemetry, no analytics — git is the only external command executed.

### Release Notes

**0.2.8** — repository metadata added for the marketplace listing (Source / Issues links).

**0.2.7** — discard a whole changelist's changes from its row (right-click + inline icon).

**0.2.6** — marketplace-ready README (English / 简体中文) and changelog; Windows path-case hardening.

**0.2.5** — idempotent re-staging (no more "changes changed" errors); discard now also syncs the index; fixes for file names containing `* ? [` characters, per-repo temp-file isolation, and staged-state preservation when committing from `default`.

**0.2.x** — per-view diff, stage support, inline file/changelist action icons, `default` node batch operations, view renamed to "Changelists", extension icon.

Full history: [CHANGELOG.md](CHANGELOG.md)

### License

MIT

---

## 中文

IDEA 风格 Changelist 的 VS Code 扩展：**把同一文件内的不同改动拆分到不同 Changelist，并只提交其中一个**（partial commit），其余改动原样保留在工作区——你的文件内容从头到尾不会被改写。

### 功能特性

- **同文件内修改拆分**——一个文件的多次修改分属不同 Changelist；分配后再编辑产生的新修改自动回到 default，可再拖到别的 Changelist
- **按视图 diff**——在某个 Changelist 下点击文件，打开「HEAD ⟷ HEAD+该视图修改」对比视图，只看到该 Changelist 改了什么
- **只提交选中的 Changelist**——`git log` 只含该 Changelist 的改动，工作区零改写，剩余改动原样保留
- **暂存（Stage）**——把 Changelist、选中文件或 hunks 暂存到 index（`git apply --cached`），工作区不动；重复暂存已暂存的改动是安全的幂等操作
- **文件行内操作**——每个文件行尾三个图标按钮：打开原文件、撤销该视图下的修改（需确认）、暂存该视图下的修改
- **Changelist 行内操作**——每个 Changelist 行尾四个图标按钮：提交、暂存、撤销（需确认）、删除
- **default 节点**——未分配的改动归入 default（IDEA 风格）；一键提交 / 暂存 / 撤销全部未分配改动
- **与原生 `git add` 共存**——提交前用 `git add` 暂存过的内容会尽量保留（自动过滤掉属于本次提交的部分）；万一无法恢复会重置暂存区并明确提示——文件内容始终不受影响
- **未跟踪文件**——新建文件作为整体 hunk 纳入管理，可分配、可暂存、可提交
- **安全守卫**——合并 / 变基 / 拣选进行中、存在未解决冲突、空仓库（无 HEAD）时拒绝提交；pre-commit hook 失败不会破坏 HEAD 与暂存区
- **拖拽分配**（VS Code 1.66+）与**多选**批量操作
- **中英双语界面**——随 VS Code 显示语言自动切换
- **自动刷新**——保存文件或 `.git` 变化（提交 / 分支切换）后自动重算

### 快速上手

1. **打开视图**——打开含 Git 仓库的文件夹，Source Control（源代码管理）面板底部会出现 **Changelists** 视图。所有改动都在 **default** 节点下，按文件展示。
2. **分配改动**——把文件拖到 Changelist 节点上；或在编辑器里选中改动区域 → 右键 → *把选中改动分配到 Changelist…*。之后的新修改会回到 default，可再拖到别的 Changelist。
3. **只提交一个**——右键 Changelist → *提交 Changelist…* → 输入提交信息（默认预填 Changelist 名）→ 回车。
4. **验证**——`git log -1 --stat` 只含该 Changelist 的改动；`git diff HEAD` 里剩下的改动还在工作区等你。

### 命令

| 命令 | 触发方式 | 说明 |
|---|---|---|
| 新建 Changelist… | 视图标题栏 ＋ 按钮 | 新建 Changelist |
| 刷新 | 视图标题栏 ⟳ 按钮 | 重新扫描仓库 |
| 提交 Changelist… | 右键 Changelist / 行尾 ✔ 图标 | 只提交该 Changelist 的改动 |
| 暂存 Changelist | 右键 Changelist / 行尾 ＋ 图标 | 把该 Changelist 暂存到 index（工作区不动） |
| 撤销改动 | 右键 Changelist / 行尾 ↺ 图标 | 撤销该 Changelist 下全部改动（需确认；其他视图不受影响） |
| 删除 Changelist | 右键 Changelist / 行尾 🗑 图标 | 删除；其下改动回到 default |
| 提交改动… | 右键 default / 行尾 ✔ 图标 | 提交全部未分配的改动 |
| 暂存改动 | 右键 default / 行尾 ＋ 图标 | 暂存全部未分配的改动 |
| 撤销改动 | 右键 default / 行尾 ↺ 图标 | 撤销全部未分配的改动（需确认；已分配的改动不受影响） |
| 打开文件 | 文件行尾 ⤴ 图标 | 在工作区打开原文件 |
| 暂存改动 | 右键文件（支持多选）/ 行尾 ＋ 图标 | 暂存该文件在当前视图下的改动 |
| 撤销修改 | 文件行尾 ↺ 图标 | 撤销该文件在当前视图下的修改（需确认；其他视图不受影响） |
| 重命名 Changelist | 右键 Changelist | 重命名 |
| 移动到 Changelist… | 右键文件（支持多选） | 移动该文件在当前视图下的改动；目标可为 Changelist 或 default |
| 把选中改动分配到 Changelist… | 编辑器右键选中区域 | 把选区命中的改动分配到 Changelist |

### 配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `changelistsPlus.gitPath` | `git` | git 可执行文件路径（非标准安装时设置） |
| `changelistsPlus.contextLines` | `3` | diff 上下文行数；越大，相距越近的改动越会被合并成同一个 hunk |

### 环境要求

- VS Code **^1.85.0**
- 系统 PATH 中可用 git（或通过 `changelistsPlus.gitPath` 配置）

### 隐私与数据

所有数据都保存在**本地**。Changelist 数据存放在 VS Code 的 workspace storage 下，按仓库根目录分 key（原子写入、损坏自动备份恢复）。不联网、无遥测、无统计——唯一的系统调用是 git。

### 更新记录

**0.2.8** —— 补充仓库元数据（市场详情页 Source / Issues 链接）。

**0.2.7** —— Changelist 行新增"撤销改动"操作（右键 + 行内图标，位于删除之前），一键撤销该 Changelist 下全部改动。

**0.2.6** —— 市场版中英双语 README 与变更记录；Windows 路径大小写兼容加固。

**0.2.5** —— 重复暂存变为幂等操作（不再报"改动已经变化"）；撤销时同步清理暂存区；修复文件名含 `* ? [` 字符、多仓库临时文件互踩、提交 default 时暂存状态丢失等问题。

**0.2.x** —— 按视图 diff、暂存功能、文件/Changelist 行内操作图标、default 节点批量操作、视图更名为 "Changelists"、扩展图标。

完整变更记录：[CHANGELOG.md](CHANGELOG.md)

### 许可证

MIT
