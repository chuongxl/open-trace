# Memory View (Phase 5)

**Source:** GitHub issue [#10](https://github.com/chuongxl/open-trace/issues/10) — `[Phase 5] Feature: Memory view — per-project AI memory browser`
**Status:** proposed
**Classification:** Bounded — one tab on `ProjectDetail`, two small components, and one small extension of an existing endpoint (`GET /api/sessions/:id/memory`, Phase 4).

## Overview

A read-only Memory tab on the project page showing the instruction/memory files the AI loads for the project, rendered as markdown, so an engineer can see exactly what context the AI holds about the codebase.

## Decisions

1. **The endpoint also returns the project's root `CLAUDE.md`.** The issue names `.claude/memory.md` and `~/.claude/CLAUDE.md`, but the file Claude Code actually loads per project is the root `CLAUDE.md` (this repository has one). Order, most specific first: `CLAUDE.md (project)`, `.claude/memory.md (project)`, `~/.claude/CLAUDE.md (global)`. The route's three copy-pasted blocks become one loop over candidates. Response shape is unchanged (additive entries only).
2. **Memory is read per session**, because the endpoint is session-scoped. The project page uses the most recent session of the project (sessions are returned newest first). A project with no sessions has no memory tab content.
3. **Tabs: Sessions | Memory**, selected through `?tab=memory` so the tab can be deep-linked and survives reload. Sessions is the default.
4. **Dot indicator** on the Memory tab when at least one file was found.
5. **Markdown via `react-markdown` + `remark-gfm`** with a small class-mapped component set (no typography plugin). Raw HTML in a file is **not** rendered (react-markdown default; no `rehype-raw`), so file content cannot inject markup or scripts. Links open in a new tab with `rel="noopener noreferrer"`.
6. **File card:** display name, shortened path, rendered content, footer with character count and last-modified time. Empty file shows "(empty file)"; no files shows an empty state naming the three locations.

## Out of scope

- OpenCode "session context from DB" (listed in the issue): there is no stored source for it today.
- Editing files (read-only), auto-memory directories, `CLAUDE.local.md`.

## Acceptance

- Memory tab on project detail; dot appears only when files exist.
- Headings, lists, code blocks, tables and links render; raw `<script>` / `<img onerror>` in a file are shown as text, not executed.
- Each file shows path, char count and modified time.
- Empty state for a project without memory files.
- `npm test` (root and dashboard), lint and build pass.
