# Changelog

## 0.1.0

First release.

- Review block that renders a Markdown file block by block and attaches CriticMarkup comments to paragraphs, list items, headings, tables and code blocks.
- Add, edit and delete comments. Edits touch only the comment's bytes, and the file is written in place so symlinks and modes survive.
- Re-reads the file before every write; an outside change reloads the file and keeps the unsaved comment.
- `tern open FILE.md` route (temp folders and `.git/` excluded), a toggle, and a "Review this Markdown file" palette command.
- `margin` CLI: `margin open` waits for the reviewer and reports `done`, `abandoned` or `closed`; `margin doctor` counts leftover CriticMarkup.
