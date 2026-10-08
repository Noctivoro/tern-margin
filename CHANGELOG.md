# Changelog

## 0.2.0

The review screen is now a Tern Surface Protocol program instead of a plugin block, so it works in every Tern client.

- New `margin review FILE` runs the review in the current pane. `margin open` starts it in a split with `tern split` and waits for its exit status, so it no longer depends on which client has focus, and plugin reloads can't end the wait early.
- Exit status is the result: 0 for done (`D`), 3 for closed early (`q`). Receipt files are gone.
- The comment box supports Tern's native editing (selection, `⌘⌫`, `⌘Z`) when it is on.
- Install with `npm install -g github:Noctivoro/tern-margin` (Node 22+). The Tern plugin is now optional and only adds the **Review this Markdown file** palette command.
- `tern open FILE.md` is no longer routed to Margin; it opens Tern's file view.
- The Luau implementation is replaced by JavaScript modules with the same rules and tests.

## 0.1.0

First release.

- Review block that renders a Markdown file block by block and attaches CriticMarkup comments to paragraphs, list items, headings, tables and code blocks.
- Add, edit and delete comments. Edits touch only the comment's bytes, and the file is written in place so symlinks and modes survive.
- Re-reads the file before every write; an outside change reloads the file and keeps the unsaved comment.
- `tern open FILE.md` route (temp folders and `.git/` excluded), a toggle, and a "Review this Markdown file" palette command.
- `margin` CLI: `margin open` waits for the reviewer and reports `done`, `abandoned` or `closed`; `margin doctor` counts leftover CriticMarkup.
