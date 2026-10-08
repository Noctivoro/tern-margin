![Margin, a plugin for Tern: review Markdown with your agents, one block at a time. Signed Nicholas DiMoro.](.github/assets/banner.jpg)

# Margin

[![Test](https://github.com/Noctivoro/tern-margin/actions/workflows/test.yml/badge.svg)](https://github.com/Noctivoro/tern-margin/actions/workflows/test.yml)

Margin is a Markdown review plugin for [Tern](https://stencil.so/tern). Open a Markdown file and Margin renders it block by block. Comment on any paragraph, list item, heading, table or code block, and the comment is saved in the file as [CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit) (`{>>comment<<}`). Git, editors and agents can all read it, and nothing else in the file changes.

Margin was built for reviewing plans and drafts with coding agents. An agent runs `margin open plan.md`, you review in Tern, and the agent gets your comments back when you press `D`.

![A Markdown file in Margin: rendered headings, a list and a table, two comments shown under their blocks, the table selected, and a comment being written at the bottom](docs/screenshot.png)

Tested with Tern 0.6.1. MIT licensed.

## Install

```sh
tern plugin install github.com/Noctivoro/tern-margin
```

The optional `margin` CLI needs Node 18 or later. On macOS:

```sh
ln -s "$HOME/Library/Application Support/Tern/plugins/margin/bin/margin.mjs" ~/.local/bin/margin
```

To work on Margin itself, clone the repo and link it instead, so Tern reloads it when you save:

```sh
git clone https://github.com/Noctivoro/tern-margin
tern plugin link "$PWD/tern-margin"
ln -s "$PWD/tern-margin/bin/margin.mjs" ~/.local/bin/margin
```

`tern plugin list` should show `margin … ready`. Opening a review needs the window half, so if your window started before the plugins folder existed, run the palette's **Reload plugins** once.

## Review a file

```sh
tern open notes.md
```

| Key | Action |
| --- | --- |
| `k` or `↓` / `j` or `↑`, click | Next block / previous block, or select by clicking |
| `g` / `G` | First or last block |
| `c`, `enter`, double-click | Comment on the selected block |
| `tab` / `shift+tab` | Next or previous comment |
| `e`, double-click a comment | Edit the selected comment |
| `x` | Delete the selected comment (`y` confirms) |
| `D` | Done: record that you finished, then close |
| `q` | Close without finishing |
| `t` | Open the file as text |
| `r` | Reload from disk |
| `?` | Show more keys |

In the comment box, `enter` saves, `shift+enter` adds a line and `esc` cancels. `⌃U`, `⌃K` and `⌃W` delete to line start, to line end and a word back. `⌘Z` undoes.

On macOS, holding a letter key shows the accent menu instead of repeating, so holding `k` or `j` moves only once. Holding `↓` or `↑` repeats. To make letters repeat in Tern (as most terminals do), turn off press-and-hold for Tern only, then quit and reopen Tern:

```sh
defaults write so.stencil.tern ApplePressAndHoldEnabled -bool false
```

`defaults delete so.stencil.tern ApplePressAndHoldEnabled` undoes it.

### Which opens use Margin

| How the file opens | Opens in |
| --- | --- |
| `tern open FILE.md` | Margin |
| `tern open` on a file under a temp folder or `.git/` (how `$EDITOR`-style tools such as `gh pr create` hand files over) | The text editor |
| A file block's **Open with › Margin** menu, or the palette's **Review this Markdown file** | Margin |
| The Files pane, the palette's file opener, links, drops | The text editor |

The palette command **Toggle Margin for `tern open`** turns the `tern open` route off and on.

## For agents and scripts

```sh
margin open docs/plan.md --json    # waits until the reviewer finishes
margin doctor docs/page.md --json  # exit 1 when CriticMarkup remains
```

`margin open` prints:

```json
{ "status": "done", "path": "…/plan.md", "comments": 3, "comments_before": 0,
  "changed": true, "pre_review_path": "…", "diff_path": "…" }
```

| `status` | Exit | Meaning |
| --- | --- | --- |
| `done` | 0 | The reviewer pressed `D` |
| `abandoned` | 3 | The reviewer pressed `q` |
| `closed` | 3 | The pane closed without the reviewer finishing |
| (error) | 4 | The file opened in a plain file block, not Margin (see below) |

`tern open --wait` alone is not a reliable done signal: a plugin reload restarts the block and can end the wait early. When the reviewer presses `D` or `q`, the block writes a receipt to `<tern state>/plugin-data/margin/receipts/`. `margin open` trusts only that receipt and waits again while the block is still running.

`margin doctor` counts CriticMarkup outside fenced code and inline code. Use it as a gate before publishing a reviewed file.

## Phones, the web client and other machines

A Margin block is an ordinary Tern pane that runs in the session daemon on the machine that holds the file. Every client attached to that daemon draws it, including the iOS app and the web client, because clients only draw what the pane sends; they run no plugin code for it. The plugin's styles travel with it.

Opening a review is different. `tern open` asks one window to open the file, normally the focused one. That window's own copy of the plugin decides that a `.md` file should open in Margin. The web client runs no plugin code, and the iOS app runs only plugins installed on the phone. So if one of those has focus when an agent calls `margin open`, the file opens as plain text and `margin open` exits with code 4. Start reviews from a desktop window with the plugin installed. You can keep reviewing on any client once the review is open.

The daemon must have the plugin installed on the machine where the file lives. For a file on a remote host, install Margin there too.

## How comments are stored

| Block | Where the comment goes |
| --- | --- |
| Paragraph, list item, heading, quote | Appended to the line the block's text ends on: `…text.{>>comment<<}` |
| Table, code block, HTML, front matter | A new paragraph after the block: `{>>comment<<}` |

Margin edits only the comment's own bytes. Adding and then deleting a comment restores the file byte for byte; the tests check this against every block of every fixture, including CRLF files. One exception: a comment after a table or code block that runs straight into the next line gets a blank line after it, and if the pane restarts (or the file changes on disk) before you delete that comment, the blank line stays. Comments inside fenced code and inline code spans are text, not comments. A `{>>` with no `<<}` before the next blank line is plain text.

The file is written in place, so symlinks and file modes survive. Before every write Margin re-reads the file. If something else changed it, Margin reloads the file and keeps your unsaved comment in the box. While a review is open, Margin also checks the file for changes once a second.

## Limits

- Margin creates comments only. It shows highlights (`{==…==}`) unwrapped, and shows insertions, deletions and substitutions as raw text.
- Comments attach to whole blocks, not word ranges.
- Tern's own key bindings can take `⌘⌫` before it reaches the comment box. `⌃U` always works.
- `tern plugin reload` reloads only the host half. After changing `window.luau`, run the palette's **Reload plugins**.

## Develop

```sh
brew install luau   # standalone Luau runtime for the unit tests
npm test            # Luau tests for the parser, comment edits and editor, plus Node tests for the CLI
```

To work on the plugin without touching your everyday window, run a second Tern with its own config, daemon and plugins folder, and drive it with `tern ctl`:

```sh
D=/tmp/margin-dev; mkdir -p $D/plugins
echo "$PWD" > $D/plugins/margin.path
(cd $D && TERN_CONFIG_DIR=$D TERN_DAEMON_SOCKET=$D/daemon.sock tern --control $D/ctl.sock $D) &
C="tern ctl --control $D/ctl.sock"
$C run '"tern open some.md"'
$C plugins expect '"Some heading"'
$C key c; $C type '"a note"'; $C key Enter
$C shot review    # PNG under $D/target/shots/tern/live/
```

Headless `tern serve` loads no plugins except Tern's own test fixtures, which is why development uses a second window. Never write files into the plugin folder from plugin code: Tern reloads the plugin on every change there.

| Path | What |
| --- | --- |
| `host.luau` | The review block: state, view, keys, file writes, receipts |
| `window.luau` | The `tern open` route and palette commands |
| `lib/blocks.luau` | Markdown to top-level blocks with source line ranges |
| `lib/critic.luau` | CriticMarkup comment helpers |
| `lib/model.luau` | Blocks plus comments, and the edits that add, change and remove comments |
| `lib/editor.luau` | The comment box's text editing |
| `cli/core.mjs`, `bin/margin.mjs` | The `margin` CLI |
| `margin.css` | Block styles, scoped to `plugin.margin.review` |

## Also by me

[Chirp](https://github.com/Noctivoro/tern-chirp) gives Tern a small robot voice that beeps when an agent finishes or needs you. Jev picks the mood, so you can hear how the turn went.

---

Made by [Nicholas DiMoro](https://nickdimoro.com).
