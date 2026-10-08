// Tests for the pure review modules (blocks, critic, model, editor).
//
// Conventions under test:
//   * offsets are 0-based UTF-16 indexes; a span's `e` is inclusive;
//   * `blocks`, `comments`, `byBlock`, `lineStart` and `lineLen` are 1-based
//     containers (index 0 unused), so their count is `count(list)`;
//   * `byBlock[b]` is a plain array of 1-based comment indexes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as blocks from "../review/blocks.mjs";
import * as critic from "../review/critic.mjs";
import * as model from "../review/model.mjs";
import { applyKey, createEditor, replace, undo } from "../review/editor.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures");
const fixtures = readdirSync(fixtureDir)
	.filter((f) => f.endsWith(".md"))
	.sort()
	.map((name) => ({ name, text: readFileSync(join(fixtureDir, name), "utf8") }));

function fixture(name) {
	const f = fixtures.find((f) => f.name === name);
	if (f === undefined) throw new Error("no fixture " + name);
	return f.text;
}

// 1-based containers leave index 0 unused.
const count = (list) => list.length - 1;

// Key as Tern delivers it to a program.
const key = (name, opts = {}) => ({
	name,
	text: opts.text,
	ctrl: opts.ctrl === true,
	alt: opts.alt === true,
	shift: opts.shift === true,
	meta: opts.meta === true,
});

const isLowSurrogate = (code) => code >= 0xdc00 && code <= 0xdfff;

// 1. Structure of the edge-case fixture.
test("1. structure of the edge-case fixture", () => {
	const m = model.build(fixture("edge-cases.md"));
	const want = [
		"frontmatter", "heading", "heading", "paragraph", "list_item", "list_item", "list_item",
		"list_item", "list_item", "quote", "table", "code", "code", "html", "rule",
		"paragraph", "paragraph", "paragraph",
	];
	assert.equal(count(m.blocks), want.length, "edge-cases block count");
	for (let i = 1; i <= want.length; i++) {
		const got = m.blocks[i] === undefined ? "nil" : m.blocks[i].kind;
		assert.equal(got, want[i - 1], "edge-cases block " + i + " kind");
	}
	assert.equal(m.blocks[3].level, 1, "setext level");
	assert.equal(m.byBlock[4].length, 2, "paragraph has inline and standalone comment");
	assert.ok(m.comments[m.byBlock[4][1]].standalone, "second paragraph comment is standalone");
	assert.equal(m.byBlock[12].length, 0, "no comments inside a fence");
	assert.equal(m.byBlock[16].length, 1, "code-span comment ignored, real one found");
	assert.equal(m.comments[m.byBlock[16][0]].body, "real", "real comment body");
	assert.equal(model.display(m, 17), "Paragraph with highlighted words.", "highlight unwrapped for display");
	assert.equal(model.display(m, 4), "A paragraph that wraps\nacross two lines.", "display drops comments and attached paragraph");
	assert.equal(m.blocks[6].last - m.blocks[6].first, 4, "bullet two spans nested items and loose paragraph");
	assert.equal(m.blocks[5].anchor, m.blocks[5].first + 1, "lazy continuation is part of the first paragraph");
});

// 1b. Fences inside list items, tables, task lists and setext headings.
test("1b. fences inside list items, tables, task lists and setext headings", () => {
	const m = model.build(fixture("guide.md"));
	assert.equal(count(m.blocks), 26, "guide block count");
	assert.equal(m.blocks[11].kind, "list_item", "step with a fence is one list item");
	assert.equal(m.blocks[11].last - m.blocks[11].first, 4, "the fence belongs to its list item");
	assert.equal(m.blocks[11].anchor, m.blocks[11].first, "comment anchors to the item's text, not the fence");
	assert.equal(m.blocks[8].kind, "table", "pipe table");
	assert.equal(m.blocks[19].kind, "heading", "setext heading with dashes");
	assert.equal(count(m.comments), 0, "markup in fences and code spans is literal");
	// A comment on a fenced list item followed directly by the next item
	// stays attached, and deleting it restores the text.
	const added = model.addComment(m, 12, "step three note");
	const m2 = model.build(added.text);
	assert.equal(m2.byBlock[12].length, 1, "comment lands on the fenced list item");
	assert.equal(model.deleteComment(m2, m2.byBlock[12][0], added.padded), fixture("guide.md"), "delete restores the guide");
});

// 2. Every non-blank line belongs to exactly one block, in order.
function coverage(name, text) {
	const rows = blocks.lines(text);
	const owner = new Array(rows.length + 1).fill(0);
	let prevLast = 0;
	const parsed = blocks.parse(text);
	for (let bi = 1; bi < parsed.length; bi++) {
		const b = parsed[bi];
		assert.ok(b.first > prevLast, name + ": block " + bi + " starts after the previous one");
		assert.ok(b.first <= b.contentLast && b.contentLast <= b.last, name + ": block " + bi + " ranges ordered");
		assert.ok(b.anchor >= b.first && b.anchor <= b.contentLast, name + ": block " + bi + " anchor in content");
		for (let l = b.first; l <= b.last; l++) {
			owner[l] += 1;
		}
		prevLast = b.last;
	}
	for (let l = 1; l <= rows.length; l++) {
		if (!/^\s*$/.test(rows[l - 1])) {
			assert.equal(owner[l], 1, name + ": line " + l + " owned once");
		}
	}
}

test("2. every non-blank line belongs to exactly one block, in order", () => {
	for (const f of fixtures) {
		coverage(f.name, f.text);
	}
});

// 3. Add, edit and delete restore the text byte for byte and keep blocks stable.
function roundtrip(name, text) {
	const m = model.build(text);
	for (let b = 1; b <= count(m.blocks); b++) {
		const beforeDisplay = model.display(m, b);
		const added = model.addComment(m, b, "Review note " + b);
		const m2 = model.build(added.text);
		assert.equal(count(m2.blocks), count(m.blocks), name + ": block count stable after comment on " + b);
		assert.equal(m2.byBlock[b].length, m.byBlock[b].length + 1, name + ": comment lands on block " + b);
		assert.equal(model.display(m2, b), beforeDisplay, name + ": display unchanged by comment on " + b);
		let newCi = -1;
		for (const ci of m2.byBlock[b]) {
			if (m2.comments[ci].body === "Review note " + b) {
				newCi = ci;
			}
		}
		assert.ok(newCi > 0, name + ": new comment found on block " + b);
		const edited = model.build(model.editComment(m2, newCi, "Changed"));
		assert.equal(edited.byBlock[b].length, m2.byBlock[b].length, name + ": edit keeps comment count on " + b);
		assert.equal(model.deleteComment(m2, newCi, added.padded), text, name + ": delete restores text for block " + b);
	}
}

test("3. add, edit and delete restore the text and keep blocks stable", () => {
	for (const f of fixtures) {
		roundtrip(f.name, f.text);
	}
});

// 4. CRLF files keep CRLF.
test("4. CRLF files keep CRLF", () => {
	const crlf = fixture("edge-cases.md").replace(/\n/g, "\r\n");
	coverage("edge-cases (crlf)", crlf);
	roundtrip("edge-cases (crlf)", crlf);
	const m = model.build(crlf);
	const added = model.addComment(m, 11, "on table");
	assert.ok(added.text.includes("|\r\n\r\n{>>on table<<}\r\n"), "standalone comment uses CRLF");
});

// 5. Sanitizing reviewer input.
test("5. sanitizing reviewer input", () => {
	assert.equal(critic.sanitize("  hi  "), "hi", "sanitize trims");
	assert.equal(critic.sanitize("a <<} b"), "a << } b", "sanitize breaks closing delimiter");
	assert.equal(critic.sanitize("a {>> b"), "a { >> b", "sanitize breaks opening delimiter");
	assert.equal(critic.sanitize("one\n\n\ntwo"), "one\ntwo", "sanitize removes blank lines");
	assert.equal(critic.sanitize("one\r\ntwo"), "one\ntwo", "sanitize drops CR");
});

// 6. ATX closing sequence stays last.
test("6. ATX closing sequence stays last", () => {
	const m = model.build("## Title ##\n");
	assert.equal(model.addComment(m, 1, "x").text, "## Title{>>x<<} ##\n", "comment goes before closing hashes");
});

// 7. Empty and comment-only documents.
test("7. empty and comment-only documents", () => {
	assert.equal(count(model.build("").blocks), 0, "empty document has no blocks");
	assert.equal(count(model.build("{>>only<<}\n").blocks), 1, "leading comment-only paragraph is its own block");
});

// 7b. Findings from the pre-release review.
test("7b. findings from the pre-release review", () => {
	// An unclosed opener must not pair with a later comment's closer.
	const stray = "first para {>> oops never closed\n\nsecond para {>>real<<} tail\n";
	const spans = critic.find(stray);
	assert.equal(spans.length, 1, "stray opener is left as text");
	assert.equal(spans[0].body, "real", "the real comment is still found");
	const m = model.build(stray);
	assert.equal(count(m.comments), 1, "model sees only the real comment");
	assert.equal(model.deleteComment(m, 1), "first para {>> oops never closed\n\nsecond para  tail\n", "delete removes only the real comment");

	// A blockquote ends at a heading or list; lazy text still continues it.
	const q = model.build("> quoted words\n# Real Heading\n\n> lazy\ncontinuation\n\n> q\n- item\n");
	const kinds = [];
	for (let bi = 1; bi < q.blocks.length; bi++) {
		kinds.push(q.blocks[bi].kind);
	}
	assert.equal(kinds.join(","), "quote,heading,quote,quote,list_item", "quote boundaries");
	assert.equal(q.blocks[3].last - q.blocks[3].first, 1, "lazy continuation stays in the quote");

	// A code span that wraps a line hides comments on the next line.
	const span = model.build("a `code span\nstill code {>>not a comment<<} end` after{>>real<<}\n");
	assert.equal(count(span.comments), 1, "comment inside a wrapped code span is text");
	assert.equal(span.comments[1].body, "real", "comment after the span is real");

	// An inline tag at a line start does not split a paragraph; a block tag does.
	assert.equal(count(model.build("text\n<span>inline</span> more\n").blocks), 1, "inline tag continues the paragraph");
	assert.equal(count(model.build("text\n<div>\nblock\n</div>\n").blocks), 2, "block tag interrupts the paragraph");

	// addComment reports where the new comment starts, even when later blocks
	// already have comments (the index of the new comment is then lower).
	const base = model.build("para one\n\np2 {>>a<<}\n\n| a | b |\n| - | - |\n| 1 | 2 |\nnext line\n");
	const t1 = model.addComment(base, 1, "new");
	const m1 = model.build(t1.text);
	assert.equal(m1.comments[1].s, t1.at, "inline offset identifies the new comment");
	let tb = 0;
	for (let bi = 1; bi < base.blocks.length; bi++) {
		if (base.blocks[bi].kind === "table") {
			tb = bi;
		}
	}
	const t2 = model.addComment(base, tb, "on table");
	const m2 = model.build(t2.text);
	let found = false;
	for (let ci = 1; ci < m2.comments.length; ci++) {
		const c = m2.comments[ci];
		if (c.s === t2.at && c.body === "on table") {
			found = true;
		}
	}
	assert.ok(found, "standalone offset identifies the new comment");
	assert.ok(t2.padded, "table followed by text gets a padding line");
});

// 8. The composer's text editing.
test("8. the composer's text editing", () => {
	const e = createEditor("");
	for (const ch of ["h", "é", "y"]) {
		applyKey(e, key(ch, { text: ch }));
	}
	assert.equal(e.text, "héy", "typing inserts characters");
	assert.equal(e.text.length, 3, "offsets count UTF-16 code units");
	applyKey(e, key("left"));
	applyKey(e, key("left"));
	assert.equal(e.cursor, 1, "left steps over a two-byte character");
	applyKey(e, key("delete"));
	assert.equal(e.text, "hy", "delete removes the whole character");
	applyKey(e, key("z", { meta: true }));
	assert.equal(e.text, "héy", "undo restores");
	const w = createEditor("one two three");
	applyKey(w, key("backspace", { alt: true }));
	assert.equal(w.text, "one two ", "alt+backspace deletes a word");
	applyKey(w, key("backspace", { meta: true }));
	assert.equal(w.text, "", "cmd+backspace deletes to line start");
	applyKey(w, key("paste", { text: "a\r\nb" }));
	assert.equal(w.text, "a\nb", "paste normalizes line endings");
	assert.ok(!applyKey(w, key("f5")), "unused keys report no change");
});

// Extra: a fixture-free round trip over emoji and accented characters.
test("8b. round trip keeps emoji and accented characters intact", () => {
	const text = "Café 😀 paragraph.\n\n| a | b |\n| - | - |\n| 😀 | café |\n";
	const m = model.build(text);
	assert.equal(count(m.blocks), 2, "paragraph and table");
	roundtrip("emoji", text);
	for (let b = 1; b <= count(m.blocks); b++) {
		const added = model.addComment(m, b, "note café 😀");
		const m2 = model.build(added.text);
		let newCi = -1;
		for (const ci of m2.byBlock[b]) {
			if (m2.comments[ci].body === "note café 😀") newCi = ci;
		}
		assert.ok(newCi > 0, "emoji comment found on block " + b);
		assert.equal(model.deleteComment(m2, newCi, added.padded), text, "emoji delete restores text for block " + b);
	}

	// The editor never lands inside the emoji's surrogate pair.
	const e = createEditor("");
	for (const ch of ["a", "😀", "b"]) {
		applyKey(e, key(ch, { text: ch }));
	}
	assert.equal(e.text, "a😀b", "typing inserts the emoji as one character");
	assert.equal(e.cursor, 4, "the cursor counts UTF-16 units");
	applyKey(e, key("left"));
	assert.equal(e.cursor, 3, "left moves before b");
	applyKey(e, key("left"));
	assert.equal(e.cursor, 1, "left steps over the whole emoji");
	applyKey(e, key("delete"));
	assert.equal(e.text, "ab", "delete removes the whole emoji");
	applyKey(e, key("right"));
	assert.equal(e.cursor, 2, "right moves past b");
	applyKey(e, key("z", { ctrl: true }));
	assert.equal(e.text, "a😀b", "ctrl+z restores the emoji");
	applyKey(e, key("down", { meta: true }));
	assert.equal(e.cursor, 4, "meta+down jumps to the end");
	// Walking left from the end always stops on a code-point boundary.
	for (let c = e.cursor; c > 0; c = e.cursor) {
		assert.ok(!isLowSurrogate(e.text.charCodeAt(c)), "the cursor never sits inside the emoji");
		if (!applyKey(e, key("left"))) break;
	}
	assert.equal(e.cursor, 0, "left reaches the start");
});

// Extra: the exported `replace` and `undo` helpers the UI drives directly.
test("9. replace sets text, cursor and undo state", () => {
	const e = createEditor("one two three");
	replace(e, 4, 7, "2", 5);
	assert.equal(e.text, "one 2 three", "range replaced");
	assert.equal(e.cursor, 5, "cursor set");
	assert.equal(e.undo.length, 1, "previous state snapshotted");
	assert.deepEqual(e.undo[0], { text: "one two three", cursor: 13 }, "snapshot is the previous state");

	// The cursor clamps to the text and never lands inside a surrogate pair.
	const s = createEditor("a😀b");
	replace(s, 1, 3, "", 999);
	assert.equal(s.text, "ab", "emoji removed");
	assert.equal(s.cursor, 2, "cursor clamped to the text");
	replace(s, 0, 0, "😀", 1);
	assert.equal(s.text, "😀ab", "emoji inserted");
	assert.equal(s.cursor, 0, "cursor pushed off the middle of the pair");
	replace(s, 2, 3, "Z", 3);
	assert.equal(s.text, "😀Zb", "range after the pair replaced");
	assert.equal(s.cursor, 3, "cursor after the replacement");
});

test("9b. undo restores the last state and reports emptiness", () => {
	const e = createEditor("ab");
	assert.ok(!undo(e), "nothing to undo");
	replace(e, 0, 1, "x", 1);
	assert.equal(e.text, "xb");
	assert.ok(undo(e), "undo reports a change");
	assert.equal(e.text, "ab", "text restored");
	assert.equal(e.cursor, 2, "cursor restored");
	assert.ok(!undo(e), "stack is empty again");
});
