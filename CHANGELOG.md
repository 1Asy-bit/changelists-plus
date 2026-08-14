# Changelog

All notable changes to Changelists Plus are documented here.

## 0.2.8

- Repository metadata (`repository` / `bugs` / `homepage`) added to the manifest for marketplace listing
- Publisher id: `1Asy-bit` (extension id: `1Asy-bit.changelists-plus`)

## 0.2.7

- **Discard a changelist**: new "Discard Changes" action on changelist rows (right-click + inline icon, before Delete) — undoes all changes assigned to that changelist; other changelists and `default` stay untouched

## 0.2.6

- **Marketplace-ready packaging**: bilingual README (English / 简体中文), CHANGELOG.md, search keywords, and gallery banner added for marketplace listing
- **Windows hardening**: repository lookup now compares paths case-insensitively (drive-letter / directory case differences on case-insensitive filesystems no longer cause refresh misses)

## 0.2.5

- **Idempotent re-staging**: staging already-staged changes (changelist, files, or hunks) is now a safe no-op with an "already staged" notice instead of an apply failure
- **Discard syncs the index**: discarding a view's changes also unstages the same hunks from the index when applicable
- **Fixes**:
  - File names containing `* ? [` are now treated literally (previously interpreted as git pathspec globs, which could make the file disappear from the view after refresh)
  - Per-repo isolation of diff-view temp files (multi-repo workspaces no longer share files)
  - Committing from `default` with pre-existing staged changes now preserves the staged state correctly
- **Tests**: 41 passing (zero-dependency, real git repositories)

## 0.2.4

- View renamed from "Smart Changelists" to "Changelists"

## 0.2.3

- Unassigned changes node renamed to **default**
- Batch operations on `default`: commit / stage / discard all unassigned changes (right-click + inline icons)

## 0.2.2

- Inline action icons on every changelist row: commit / stage / delete

## 0.2.1

- Inline action icons on every file row: open file / discard this view's changes / stage this view's changes
- Extension icon (marketplace, title bar)

## 0.2.0

- IDEA-style file-level view: files are listed per changelist with change counts instead of expanded hunks
- Per-view diff: clicking a file opens "HEAD ⟷ HEAD + this view's changes" comparison
- Stage support: stage a changelist or selected hunks to the index without touching the working tree
- Discard support: undo changes of one view only, other views stay
- Drag & drop and multi-select assignment
