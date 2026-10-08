// The Margin review screen: a Tern Surface Protocol program. It runs in a
// pane like any command, so every Tern client attached to that pane draws it
// natively (desktop, iOS, web) without any plugin code on the client.
//
// The program renders a Markdown file block by block, shows CriticMarkup
// comments under the block they belong to, and adds, edits and deletes
// comments in the file. Its exit status is the review result:
//   0  the reviewer pressed D (done)
//   3  the reviewer pressed q or Ctrl+C in browse mode (closed without finishing)
//   4  the review lost its screen or its session ended without a result
// Any other exit (the pane closed, a crash) means the review did not finish.

import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { connect, span, ui } from '@stencil-hq/tern';
import * as critic from './critic.mjs';
import * as editor from './editor.mjs';
import * as model from './model.mjs';

export const EXIT_DONE = 0;
export const EXIT_ABANDONED = 3;
export const EXIT_LOST = 4;
export const EXIT_NO_SURFACE = 5;

const MAX_BYTES = 4 * 1024 * 1024;
const POLL_MS = 1000;

const STYLES = `
[data-role='margin.head'] { padding: 0 10px 6px; margin-bottom: 4px; border-bottom: 1px solid var(--l1); }
[data-role='margin.block'] { padding: 2px 10px 2px 12px; border-radius: 6px; border-left: 2px solid transparent; }
[data-role='margin.block']:hover { background: rgb(from var(--accent) r g b / 4%); }
[data-role='margin.block'][data-tone='accent'] { border-left-color: var(--accent); background: rgb(from var(--accent) r g b / 7%); }
[data-role='margin.comment'] { margin: 4px 0 6px; padding: 6px 10px; border-radius: 6px; background: rgb(from var(--accent) r g b / 9%); border-left: 2px solid rgb(from var(--accent) r g b / 45%); }
[data-role='margin.comment'][data-tone='accent'] { border-left-color: var(--accent); box-shadow: inset 0 0 0 1px rgb(from var(--accent) r g b / 40%); }
[data-role='margin.chip'] { cursor: pointer; }
`;

// --- file access -----------------------------------------------------------

function readText(path) {
	try {
		if (statSync(path).size > MAX_BYTES) return { error: 'The file is larger than 4 MiB.' };
		return { text: readFileSync(path, 'utf8') };
	} catch (err) {
		return { error: err.message };
	}
}

// --- model accessors (1-based block and comment indexes) --------------------

// review/model.mjs uses 1-based containers (index 0 unused).
const blockCount = (m) => m.blocks.length - 1;
const commentCount = (m) => m.comments.length - 1;
const commentAt = (m, ci) => m.comments[ci];
const commentsOf = (m, b) => m.byBlock[b] ?? [];

// The block's first line without Markdown syntax, for "Comment on …".
export function preview(markdown) {
	let line = markdown.split('\n', 1)[0] ?? '';
	line = line.replace(/^[#>\-+*\s\d.)|]+/, '');
	line = line.replace(/[*_`]/g, '');
	line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	// A table's header row reads as its cells: "Step · Owner · Command".
	line = line.replace(/\s*\|\s*/g, ' · ');
	return line.replace(/^( · )+/, '').replace(/( · )+$/, '');
}

// --- the review state machine ----------------------------------------------

/**
 * Holds everything the screen shows and every rule for changing the file.
 * Separate from the surface so tests can drive it without Tern.
 */
export class Review {
	constructor(path) {
		this.path = path;
		this.text = '';
		this.m = model.build('');
		this.error = null;
		this.sel = 1;
		this.csel = null; // selected comment index, always on block `sel`
		this.mode = 'browse'; // browse | compose | edit | confirm
		this.ed = editor.createEditor('');
		// Standalone comments added this run that brought a blank line after
		// them, by the offset of their `{`. Kept in step with every save and
		// dropped on any outside change, so a delete never removes the wrong
		// line break.
		this.padded = new Set();
		this.stale = false;
		this.help = false;
		this.status = null;
		this.notice = null; // { level, text } shown in the dock, cleared on the next key
		this.load();
	}

	// Loads the file from disk.
	load() {
		const r = readText(this.path);
		if (r.error) {
			this.error = r.error;
			this.text = '';
			this.m = model.build('');
			this.padded.clear();
			this.csel = null;
			return;
		}
		if (r.text !== this.text) this.applyOutside(r.text);
		else this.apply(r.text);
	}

	apply(text) {
		this.text = text;
		this.m = model.build(text);
		this.error = null;
		const n = blockCount(this.m);
		if (this.sel > n) this.sel = n;
		if (this.sel < 1 && n > 0) this.sel = 1;
		const c = this.csel ? commentAt(this.m, this.csel) : null;
		if (!c || c.block !== this.sel) this.csel = null;
	}

	// Text that changed outside the review. Comment indexes and padded
	// offsets no longer point where they did, so both are dropped: an index
	// kept here could make an edit or delete hit a different comment.
	applyOutside(text) {
		this.padded.clear();
		this.csel = null;
		this.apply(text);
	}

	// Moves padded offsets past the first character that differs between the
	// old and new text, so they keep pointing at the same comments.
	shiftPadded(oldText, newText) {
		if (this.padded.size === 0) return;
		let common = 0;
		const limit = Math.min(oldText.length, newText.length);
		while (common < limit && oldText.charCodeAt(common) === newText.charCodeAt(common)) common++;
		const delta = newText.length - oldText.length;
		this.padded = new Set([...this.padded].map((s) => (s > common ? s + delta : s)));
	}

	// Writes `text` if the file still holds what the review last loaded.
	// In place, not temp-file-and-rename: a rename would replace a symlink
	// with a plain file and reset the file's mode.
	commit(text) {
		const disk = readText(this.path);
		if (disk.error) {
			this.notice = { level: 'error', text: `Could not read ${basename(this.path)}: ${disk.error}` };
			return false;
		}
		if (disk.text !== this.text) {
			this.applyOutside(disk.text);
			let text = 'The file changed outside the review. Reloaded it; nothing was changed.';
			if (this.mode === 'compose') {
				text = 'The file changed outside the review. Reloaded it; your comment is still in the box.';
			} else if (this.mode === 'edit') {
				// The comment being edited can no longer be identified safely.
				this.mode = 'compose';
				text = 'The file changed outside the review. Reloaded it; your text is still in the box and will be saved as a new comment.';
			}
			this.notice = { level: 'error', text };
			return false;
		}
		try {
			writeFileSync(this.path, text);
		} catch (err) {
			this.notice = { level: 'error', text: `Could not save ${basename(this.path)}: ${err.message}` };
			this.padded.clear();
			this.load();
			return false;
		}
		this.shiftPadded(this.text, text);
		this.apply(text);
		this.status = 'Saved';
		return true;
	}

	// Checks the file for outside changes; returns true when the view changed.
	poll() {
		const disk = readText(this.path);
		if (disk.error || disk.text === this.text) return false;
		if (this.mode === 'browse' || this.mode === 'confirm') {
			this.applyOutside(disk.text);
			this.mode = 'browse';
			this.status = 'Reloaded: the file changed on disk';
			return true;
		}
		this.stale = true;
		return false;
	}

	select(b) {
		const n = blockCount(this.m);
		if (n === 0) return;
		this.sel = Math.min(Math.max(b, 1), n);
		this.csel = null;
	}

	cycleComment(dir) {
		const n = commentCount(this.m);
		if (n === 0) return;
		let next;
		if (this.csel === null) {
			next = dir > 0 ? 1 : n;
			for (let ci = 1; ci <= n; ci++) {
				const c = commentAt(this.m, ci);
				if (dir > 0 && c.block >= this.sel) {
					next = ci;
					break;
				}
				if (dir < 0 && c.block <= this.sel) next = ci;
			}
		} else {
			next = ((this.csel - 1 + dir + n) % n) + 1;
		}
		this.csel = next;
		this.sel = commentAt(this.m, next).block;
	}

	startCompose(mode, text) {
		this.mode = mode;
		this.ed = editor.createEditor(text);
		this.status = null;
	}

	submit() {
		const body = critic.sanitize(this.ed.text);
		if (body === '') {
			this.mode = this.mode === 'edit' && this.csel ? 'confirm' : 'browse';
			return;
		}
		// An outside change can drop the comment being edited (its block moved
		// or it was deleted); save the draft as a new comment rather than
		// leaving a Save key that does nothing.
		if (this.mode === 'edit' && !this.csel) this.mode = 'compose';
		if (this.mode === 'compose') {
			// The file may have been emptied (or become unreadable) since the
			// box opened; keep the draft and say why it can't be saved.
			if (blockCount(this.m) === 0 || this.error) {
				this.notice = { level: 'error', text: 'The file has no blocks now; there is nothing to attach the comment to. Your text is still in the box.' };
				return;
			}
			const { text, padded, at } = model.addComment(this.m, this.sel, body);
			if (!this.commit(text)) return;
			this.mode = 'browse';
			this.csel = null;
			for (let ci = 1; ci <= commentCount(this.m); ci++) {
				if (commentAt(this.m, ci).s === at) this.csel = ci;
			}
			if (padded) this.padded.add(at);
		} else if (this.mode === 'edit') {
			const ci = this.csel;
			if (this.commit(model.editComment(this.m, ci, body))) {
				this.mode = 'browse';
				this.csel = ci;
			}
		}
		this.reloadIfStale();
	}

	deleteSelected() {
		const ci = this.csel;
		if (!ci) {
			this.mode = 'browse';
			return;
		}
		const at = commentAt(this.m, ci).s;
		const padded = this.padded.has(at);
		this.padded.delete(at);
		if (this.commit(model.deleteComment(this.m, ci, padded))) {
			this.csel = null;
			this.status = 'Comment deleted';
		}
		this.mode = 'browse';
	}

	cancelCompose() {
		this.mode = 'browse';
		this.reloadIfStale();
	}

	reloadIfStale() {
		if (this.mode === 'browse' && this.stale) {
			this.stale = false;
			this.load();
		}
	}
}

// --- view --------------------------------------------------------------------

function chip(key, label, onClick) {
	return ui.text({ role: 'margin.chip', onClick }, span(key, 'key'), span(` ${label}`, 'muted'));
}

/** The whole screen for `r`; `act` receives chip and click actions. */
export function view(r, act) {
	const n = commentCount(r.m);
	const head = ui.row({ key: 'head', role: 'margin.head' },
		ui.text({ truncate: 'middle' }, span(basename(r.path), 'strong')),
		ui.row({ grow: 1 }),
		ui.text({},
			span(r.status ? `${r.status}  ·  ` : '', 'muted'),
			span(n === 1 ? '1 comment' : `${n} comments`, n > 0 ? 'accent' : 'muted')));

	let doc;
	if (r.error) {
		doc = ui.col({ key: 'doc' }, ui.card({ head: `Cannot open ${basename(r.path)}`, tone: 'error' }, ui.text({}, span(r.error, 'muted'))));
	} else if (blockCount(r.m) === 0) {
		doc = ui.col({ key: 'doc' }, ui.text({}, span('This file is empty.', 'muted')));
	} else {
		doc = ui.col({ key: 'doc', gap: 'xs', role: 'margin.doc' },
			...Array.from({ length: blockCount(r.m) }, (_, i) => {
				const b = i + 1;
				return ui.col({
					key: `b${b}`,
					role: 'margin.block',
					tone: b === r.sel ? 'accent' : undefined,
					onClick: () => act('select', b),
					onDblClick: () => act('compose-at', b),
				},
				ui.md({ key: 'md' }, model.display(r.m, b)),
				...commentsOf(r.m, b).map((ci) =>
					ui.col({
						key: `c${ci}`,
						role: 'margin.comment',
						tone: r.csel === ci ? 'accent' : undefined,
						onClick: () => act('comment', ci),
						onDblClick: () => act('edit-comment', ci),
					}, ui.text({ wrap: 'word' }, commentAt(r.m, ci).body))));
			}));
	}

	return { main: ui.col({}, head, doc), dock: dock(r, act) };
}

function dock(r, act) {
	const notice = r.notice ? ui.text({ key: 'notice' }, span(r.notice.text, r.notice.level === 'error' ? 'error' : 'muted')) : null;
	if (r.mode === 'compose' || r.mode === 'edit') {
		const target = blockCount(r.m) > 0 ? preview(model.display(r.m, r.sel)) : '';
		return ui.col({},
			...(notice ? [notice] : []),
			ui.text({ truncate: 'end' },
				span(r.mode === 'edit' ? 'Edit comment on  ' : 'Comment on  ', 'muted'),
				span(target, 'strong')),
			ui.editor({
				key: 'composer',
				text: r.ed.text,
				cursor: r.ed.cursor,
				placeholder: 'Write a comment. Enter saves, Shift+Enter adds a line, Esc cancels.',
				maxLines: 6,
				aria: 'Comment',
				onEdit: (ev) => act('native-edit', ev),
				onUndo: () => act('native-undo'),
			}));
	}
	if (r.mode === 'confirm') {
		return ui.col({},
			ui.row({},
				ui.text({}, span('Delete this comment?', 'strong')),
				chip('y', 'Delete', () => act('delete')),
				chip('n', 'Keep', () => act('browse'))));
	}
	const chips = [chip('c', 'Comment', () => act('compose'))];
	if (r.csel) {
		chips.push(chip('e', 'Edit', () => act('edit')));
		chips.push(chip('x', 'Delete', () => act('confirm')));
	}
	chips.push(chip('tab', 'Next comment', () => act('next')));
	chips.push(chip('D', 'Done', () => act('done')));
	chips.push(chip('?', 'Keys', () => act('help')));
	const rows = [ui.row({ key: 'chips', gap: 'md', wrap: true }, ...chips)];
	if (r.help) {
		rows.push(ui.row({ key: 'more', gap: 'md', wrap: true },
			chip('k j', 'Down, up', () => {}),
			chip('g G', 'Top, bottom', () => {}),
			chip('shift+tab', 'Previous comment', () => act('prev')),
			chip('t', 'Open as text', () => act('text')),
			chip('r', 'Reload', () => act('reload')),
			chip('q', 'Close without finishing', () => act('quit'))));
	}
	return ui.col({}, ...(notice ? [notice] : []), ...rows);
}

// --- program -----------------------------------------------------------------

/**
 * Runs the review on `path` in the current pane. Resolves to the exit status:
 * EXIT_DONE, EXIT_ABANDONED, EXIT_LOST, or EXIT_NO_SURFACE outside Tern.
 */
export async function runReview(path) {
	const session = await connect({ app: 'margin', features: ['edit', 'undo'] });
	if (!session) return EXIT_NO_SURFACE;
	const r = new Review(path);
	const surface = session.open({ mode: 'screen', title: `Review ${basename(path)}`, role: 'margin.review' });
	surface.stylesheet('margin', STYLES);

	let result = null;
	// Clicks run inside the input iterator and yield nothing, so a click on
	// Done or Close settles this promise to end the run right away.
	let finished;
	const settled = new Promise((resolve) => {
		finished = resolve;
	});
	const reveal = (ahead) => {
		if (blockCount(r.m) === 0) return; // no block nodes to scroll to
		const b = ahead ? Math.min(Math.max(r.sel + ahead, 1), blockCount(r.m)) : r.sel;
		surface.reveal(ahead || !r.csel ? `main.doc.b${b}` : `main.doc.b${b}.c${r.csel}`, 'nearest');
	};
	const focusComposer = () => surface.focus('dock.composer');

	const act = (name, arg) => {
		if (result !== null) return;
		switch (name) {
			case 'select':
				if (r.mode === 'browse') r.select(arg);
				break;
			case 'compose-at':
				if (r.mode === 'browse') {
					r.select(arg);
					act('compose');
				}
				return;
			case 'comment':
			case 'edit-comment':
				if (r.mode === 'browse' && commentAt(r.m, arg)) {
					r.sel = commentAt(r.m, arg).block;
					r.csel = arg;
					if (name === 'edit-comment') {
						act('edit');
						return;
					}
				}
				break;
			case 'compose':
				if (blockCount(r.m) > 0 && !r.error) {
					r.startCompose('compose', '');
					draw();
					focusComposer();
					return;
				}
				break;
			case 'edit':
				if (r.csel) {
					r.startCompose('edit', commentAt(r.m, r.csel).body);
					draw();
					focusComposer();
					return;
				}
				break;
			case 'confirm':
				if (r.csel) r.mode = 'confirm';
				break;
			case 'delete':
				r.deleteSelected();
				break;
			case 'browse':
				r.mode = 'browse';
				break;
			case 'next':
			case 'prev':
				r.cycleComment(name === 'next' ? 1 : -1);
				draw();
				reveal();
				return;
			case 'help':
				r.help = !r.help;
				break;
			case 'reload':
				r.load();
				r.status = 'Reloaded';
				break;
			case 'text':
				// A Tern file block beside this pane; the review keeps running.
				spawn('tern', ['open', r.path], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
				return;
			case 'done':
				result = EXIT_DONE;
				finished();
				return;
			case 'quit':
				result = EXIT_ABANDONED;
				finished();
				return;
			case 'native-edit': {
				// Tern applied an edit to its own selection in the composer. Its
				// offsets are against the text it last saw (`len`); when keys we
				// applied are still in flight, they would land in the wrong place,
				// so the protocol says to drop the event.
				const ev = arg;
				if (r.mode !== 'compose' && r.mode !== 'edit') return;
				if (ev.len !== r.ed.text.length) return;
				editor.replace(r.ed, ev.from, ev.to, ev.text, ev.cursor);
				break;
			}
			case 'native-undo':
				editor.undo(r.ed);
				break;
		}
		draw();
	};

	const draw = () => surface.render(view(r, act));

	const browseKey = (k) => {
		const { name, text } = k;
		if (k.meta || k.ctrl) {
			if (k.ctrl && (name === 'c' || name === 'd')) act('quit');
			return;
		}
		if (name === 'k' || name === 'down') {
			r.select(r.sel + 1);
			draw();
			reveal(1);
		} else if (name === 'j' || name === 'up') {
			r.select(r.sel - 1);
			draw();
			reveal(-1);
		} else if (text === 'G' || name === 'end') {
			r.select(blockCount(r.m));
			draw();
			reveal();
		} else if (text === 'g' || name === 'home') {
			r.select(1);
			draw();
			reveal();
		} else if (name === 'pagedown' || name === 'page_down') surface.scroll('main.doc', 'page-down');
		else if (name === 'pageup' || name === 'page_up') surface.scroll('main.doc', 'page-up');
		else if (name === 'c' || name === 'enter') act('compose');
		else if (name === 'tab') act(k.shift ? 'prev' : 'next');
		else if (name === 'e') act('edit');
		else if (name === 'x' || name === 'backspace' || name === 'delete') act('confirm');
		else if (text === 'D') act('done');
		else if (name === 'q') act('quit');
		else if (name === 'r') act('reload');
		else if (name === 't') act('text');
		else if (text === '?') act('help');
		else if (name === 'escape') {
			r.csel = null;
			r.help = false;
			draw();
		}
	};

	const composeKey = (k) => {
		if (k.name === 'escape' || (k.ctrl && (k.name === 'c' || k.name === 'd'))) {
			r.cancelCompose();
			draw();
		} else if (k.name === 'enter' && !k.shift && !k.alt) {
			r.submit();
			draw();
			if (r.mode !== 'browse') focusComposer();
		} else if (editor.applyKey(r.ed, k)) draw();
	};

	const timer = setInterval(() => {
		if (r.poll()) draw();
	}, POLL_MS);

	draw();
	const keys = (async () => {
		for await (const input of session) {
			if (input.type === 'event') {
				// RIS or an alternate-screen exit can discard the screen surface
				// (`ids` then names the surface itself, not just nodes); without
				// it the reviewer sees nothing, so end the review.
				const ev = input.event;
				if (ev.ev === 'gone' && ev.sf !== undefined && ev.ids.includes(ev.sf)) {
					result = EXIT_LOST;
					break;
				}
				continue;
			}
			if (input.type !== 'key') continue;
			const k = input.key;
			if (r.notice) r.notice = null;
			if (r.mode === 'compose' || r.mode === 'edit') composeKey(k);
			else if (r.mode === 'confirm') {
				if (k.name === 'y' || k.name === 'enter') act('delete');
				else if (k.name === 'n' || k.name === 'escape' || (k.ctrl && (k.name === 'c' || k.name === 'd'))) act('browse');
			} else browseKey(k);
			if (result !== null) break;
		}
	})();
	try {
		await Promise.race([keys, settled]);
	} finally {
		clearInterval(timer);
		await session.close();
		// The input loop may still be parked on a read; the caller exits the
		// process, so only silence a late rejection.
		keys.catch(() => {});
	}
	return result ?? EXIT_LOST;
}
