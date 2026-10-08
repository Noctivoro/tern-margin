import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preview, Review } from "../review/app.mjs";

function tempFile(text, name = "doc.md") {
	const dir = mkdtempSync(join(tmpdir(), "margin-app-"));
	const path = join(dir, name);
	writeFileSync(path, text);
	return path;
}

function comment(r, body) {
	r.startCompose("compose", body);
	r.submit();
}

test("a new comment is saved, selected, and deleting it restores the file", () => {
	const original = "Intro\n\nLater {>>existing<<}\n";
	const path = tempFile(original);
	const r = new Review(path);
	r.select(1);
	comment(r, "on intro");
	assert.equal(readFileSync(path, "utf8"), "Intro{>>on intro<<}\n\nLater {>>existing<<}\n");
	assert.equal(r.mode, "browse");
	assert.equal(r.m.comments[r.csel].body, "on intro", "the new comment is selected even though a later comment exists");
	r.deleteSelected();
	assert.equal(readFileSync(path, "utf8"), original);
});

test("a padded comment after a table restores exactly, even after other edits", () => {
	const original = "| a | b |\n| - | - |\n| 1 | 2 |\nnext line\n\nTail\n";
	const path = tempFile(original);
	const r = new Review(path);
	r.select(1);
	comment(r, "on table");
	const tableComment = r.csel;
	r.select(r.m.blocks.length - 1); // Tail
	comment(r, "on tail");
	r.csel = tableComment;
	r.sel = r.m.comments[tableComment].block;
	r.deleteSelected();
	r.select(r.m.blocks.length - 1);
	r.csel = r.m.byBlock[r.sel][0];
	r.deleteSelected();
	assert.equal(readFileSync(path, "utf8"), original);
});

test("an outside change blocks the save, reloads, and keeps the draft", () => {
	const path = tempFile("One\n\nTwo\n");
	const r = new Review(path);
	r.startCompose("compose", "draft");
	writeFileSync(path, "One\n\nTwo\n\nThree\n");
	r.submit();
	assert.equal(r.mode, "compose", "still composing");
	assert.equal(r.ed.text, "draft", "the draft survives");
	assert.match(r.notice.text, /changed outside the review/);
	assert.equal(readFileSync(path, "utf8"), "One\n\nTwo\n\nThree\n", "the outside change is not overwritten");
	r.submit();
	assert.match(readFileSync(path, "utf8"), /\{>>draft<<\}/, "the second try saves");
});

test("editing a comment across an outside change saves the text as a new comment, never over another one", () => {
	const path = tempFile("Para {>>old<<}\n");
	const r = new Review(path);
	r.csel = 1;
	r.startCompose("edit", "rewritten");
	// Someone adds a comment before ours on the same block.
	writeFileSync(path, "Para {>>theirs<<}{>>old<<}\n");
	r.submit();
	assert.equal(r.mode, "compose", "falls back to a new comment");
	assert.match(r.notice.text, /saved as a new comment/);
	r.submit();
	assert.equal(readFileSync(path, "utf8"), "Para {>>theirs<<}{>>old<<}{>>rewritten<<}\n", "both earlier comments survive");
});

test("a delete blocked by an outside change says nothing was changed", () => {
	const path = tempFile("A{>>x<<}\n");
	const r = new Review(path);
	r.csel = 1;
	writeFileSync(path, "A{>>x<<}\n\nB\n");
	r.deleteSelected();
	assert.equal(r.mode, "browse");
	assert.match(r.notice.text, /nothing was changed/);
	assert.equal(readFileSync(path, "utf8"), "A{>>x<<}\n\nB\n");
});

test("poll reloads outside changes in browse mode and waits while composing", () => {
	const path = tempFile("One\n");
	const r = new Review(path);
	writeFileSync(path, "One\n\nTwo\n");
	assert.equal(r.poll(), true);
	assert.equal(r.m.blocks.length - 1, 2);
	r.startCompose("compose", "x");
	writeFileSync(path, "One\n\nTwo\n\nThree\n");
	assert.equal(r.poll(), false, "no reload under the composer");
	r.cancelCompose();
	assert.equal(r.m.blocks.length - 1, 3, "cancel reloads the stale file");
});

test("writes go through a symlink and keep it a symlink", () => {
	const path = tempFile("Hello\n", "real.md");
	const link = join(path, "..", "link.md");
	symlinkSync(path, link);
	const r = new Review(link);
	comment(r, "via link");
	assert.ok(lstatSync(link).isSymbolicLink());
	assert.equal(readFileSync(path, "utf8"), "Hello{>>via link<<}\n");
});

test("an empty comment edit asks to delete instead of saving nothing", () => {
	const path = tempFile("Hi{>>old<<}\n");
	const r = new Review(path);
	r.csel = 1;
	r.startCompose("edit", "   ");
	r.submit();
	assert.equal(r.mode, "confirm");
});

test("comment cycling wraps and follows the comment's block", () => {
	const path = tempFile("A{>>1<<}\n\nB\n\nC{>>2<<}\n");
	const r = new Review(path);
	r.select(2);
	r.cycleComment(1);
	assert.equal(r.m.comments[r.csel].body, "2");
	assert.equal(r.sel, 3);
	r.cycleComment(1);
	assert.equal(r.m.comments[r.csel].body, "1");
	assert.equal(r.sel, 1);
});

test("a missing file shows an error instead of throwing", () => {
	const r = new Review(join(tmpdir(), "margin-does-not-exist.md"));
	assert.ok(r.error);
});

test("preview strips Markdown syntax and joins table cells", () => {
	assert.equal(preview("## **Bold** [link](x) `code`"), "Bold link code");
	assert.equal(preview("| Step | Owner |\n| - | - |"), "Step · Owner");
});

test("saving into a file emptied from outside keeps the draft instead of crashing", () => {
	const path = tempFile("One\n");
	const r = new Review(path);
	r.startCompose("compose", "draft");
	writeFileSync(path, "");
	r.submit(); // conflict: reloads the empty file
	r.submit(); // nothing to attach to
	assert.equal(r.mode, "compose");
	assert.equal(r.ed.text, "draft");
	assert.match(r.notice.text, /nothing to attach/);
	assert.equal(readFileSync(path, "utf8"), "");
});
