// The review document: blocks, the comments attached to them, and the text
// edits that add, change and remove comments. Pure: no `tern` calls.
//
// Every edit touches only the characters of one comment (plus the line breaks
// a standalone comment brought with it), so adding and then deleting a
// comment restores the original text exactly.
//
// Indexing:
//   * offsets (`s`, `e`, `at`, `lineStart` values, editor cursors) are 0-based
//     UTF-16 code-unit indexes, and a comment span's `e` is inclusive (the
//     index of the final "}");
//   * line numbers, block indexes `b`, comment indexes `ci` and the entry
//     values of `byBlock` are 1-based;
//   * `blocks`, `comments`, `byBlock`, `lineStart` and `lineLen` are 1-based
//     containers: index 0 is unused, so their count is `arr.length - 1`;
//   * `byBlock[b]` itself is a plain array of 1-based comment indexes, in
//     source order, so it can be iterated directly.
import * as blocks from "./blocks.mjs";
import * as critic from "./critic.mjs";

const INLINE = { paragraph: true, heading: true, list_item: true, quote: true };
const LITERAL = { code: true, frontmatter: true, html: true };

function lineOf(m, offset) {
	let lo = 1;
	let hi = m.lineStart.length - 1;
	while (lo < hi) {
		const mid = Math.floor((lo + hi + 1) / 2);
		if (m.lineStart[mid] <= offset) {
			lo = mid;
		} else {
			hi = mid - 1;
		}
	}
	return lo;
}

// Offset just past the line's last character, before any "\r".
function lineEnd(m, line) {
	const s = m.lineStart[line];
	let len = m.lineLen[line];
	if (len > 0 && m.text[s + len - 1] === "\r") {
		len -= 1;
	}
	return s + len;
}

// Whether `offset` falls inside a backtick code span. Code spans can wrap
// lines, so count from `from`, the start of the paragraph holding `offset`,
// ignoring backticks inside earlier comments.
function inCodeSpan(m, from, offset) {
	const before = critic.stripComments(m.text.slice(from, offset));
	const ticks = (before.match(/`/g) ?? []).length;
	return ticks % 2 === 1;
}

export function build(text) {
	const raw = blocks.lines(text);
	const lineStart = []; // 1-based: index 0 stays unused
	const lineLen = [];
	let pos = 0;
	for (let i = 1; i <= raw.length; i++) {
		lineStart[i] = pos;
		lineLen[i] = raw[i - 1].length;
		pos += raw[i - 1].length + 1;
	}
	const nl = text.includes("\r\n") ? "\r\n" : "\n";
	const m = {
		text,
		lineStart,
		lineLen,
		nl,
		blocks: blocks.parse(text),
		comments: [undefined], // 1-based: index 0 stays unused
		byBlock: [],
	};
	for (let b = 1; b < m.blocks.length; b++) {
		m.byBlock[b] = [];
	}
	let bi = 1;
	const blockCount = m.blocks.length - 1;
	for (const sp of critic.find(text)) {
		const line = lineOf(m, sp.s);
		while (bi <= blockCount && m.blocks[bi].last < line) {
			bi += 1;
		}
		const blk = m.blocks[bi];
		if (blk === undefined || line < blk.first) {
			continue;
		}
		if (LITERAL[blk.kind] && line <= blk.contentLast) {
			continue;
		}
		const paraFirst = line > blk.contentLast ? blk.contentLast + 1 : blk.first;
		if (inCodeSpan(m, m.lineStart[paraFirst], sp.s)) {
			continue;
		}
		const standalone = line > blk.contentLast;
		m.comments.push({ block: bi, s: sp.s, e: sp.e, body: sp.body, standalone });
		m.byBlock[bi].push(m.comments.length - 1);
	}
	return m;
}

// The block's Markdown as a reader should see it: comments removed,
// highlight markers unwrapped, trailing blank lines dropped, front matter
// shown as a YAML code block instead of a rule and a setext heading.
export function display(m, b) {
	const blk = m.blocks[b];
	if (blk.kind === "frontmatter") {
		const s = m.lineStart[blk.first + 1];
		const e = m.lineStart[blk.contentLast] - 1;
		const inner = blk.contentLast > blk.first + 1 ? m.text.slice(s, e) : "";
		return "```yaml\n" + inner.replace(/\r/g, "") + "\n```";
	}
	const s = m.lineStart[blk.first];
	const e = m.lineStart[blk.last] + m.lineLen[blk.last] - 1;
	const parts = [];
	let pos = s;
	for (const ci of m.byBlock[b]) {
		const c = m.comments[ci];
		parts.push(m.text.slice(pos, c.s));
		pos = c.e + 1;
	}
	parts.push(m.text.slice(pos, e + 1));
	let out = parts.join("");
	if (!LITERAL[blk.kind]) {
		out = critic.unwrapHighlights(out);
	}
	return out.replace(/[ \t\r\n]+$/, "");
}

function splice(text, from, to, insert) {
	return text.slice(0, from) + insert + text.slice(to + 1);
}

// Text with a new comment on block `b`. `body` must already be sanitized.
// Also returns:
//   * `padded`: whether a standalone comment needed a blank line after it (the
//     block ran straight into the next line). Pass it back to `deleteComment`
//     to restore the text exactly; the text alone cannot tell that case apart
//     from a comment that already had a blank line after it;
//   * `at`: the offset of the new comment's `{` in the returned text, which
//     identifies it in the rebuilt model.
export function addComment(m, b, body) {
	const blk = m.blocks[b];
	const span = critic.wrap(body);
	if (INLINE[blk.kind]) {
		let at = lineEnd(m, blk.anchor);
		if (blk.kind === "heading" && blk.anchor === blk.first) {
			// Keep an ATX closing sequence ("## Title ##") last on the line.
			const line = m.text.slice(m.lineStart[blk.anchor], at);
			const closing = /\s+#+\s*$/.exec(line);
			if (closing !== null) {
				at -= closing[0].length;
			}
		}
		return { text: splice(m.text, at, at - 1, span), padded: false, at };
	}
	const at = lineEnd(m, blk.last);
	const nextLine = blk.last + 1;
	const pad =
		m.lineStart[nextLine] !== undefined &&
		!/^\s*$/.test(m.text.slice(m.lineStart[nextLine], m.lineStart[nextLine] + m.lineLen[nextLine]));
	const insert = m.nl + m.nl + span + (pad ? m.nl : "");
	return { text: splice(m.text, at, at - 1, insert), padded: pad, at: at + 2 * m.nl.length };
}

export function editComment(m, ci, body) {
	const c = m.comments[ci];
	return splice(m.text, c.s, c.e, critic.wrap(body));
}

// `padded`: the value `addComment` returned for this comment.
export function deleteComment(m, ci, padded) {
	const c = m.comments[ci];
	let from = c.s;
	let to = c.e;
	if (c.standalone) {
		const lead = m.nl + m.nl;
		const after = m.text.slice(to + 1, to + 1 + m.nl.length);
		if (m.text.slice(from - lead.length, from) === lead && (after === m.nl || after === "")) {
			from -= lead.length;
			if (padded && m.text.slice(to + 1, to + 1 + 2 * m.nl.length) === lead) {
				to += m.nl.length;
			}
		}
	}
	return splice(m.text, from, to, "");
}
