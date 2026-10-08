import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countMarkup, findReceipt, receiptsDir } from "../cli/core.mjs";

test("countMarkup ignores fences and inline code", () => {
	const text = [
		"Para{>>one<<} and {++add++} and {==hi==}{>>two<<}",
		"Inline `{>>not counted<<}` span.",
		"```md",
		"{>>inside fence<<} {--x--}",
		"```",
		"~~~~",
		"{~~a~>b~~}",
		"~~~~",
		"After{--gone--}",
	].join("\n");
	const c = countMarkup(text);
	assert.equal(c.comments, 2);
	assert.equal(c.insertions, 1);
	assert.equal(c.deletions, 1);
	assert.equal(c.substitutions, 0);
	assert.equal(c.highlights, 1);
	assert.equal(c.total, 5);
});

test("countMarkup: an unclosed fence hides the rest", () => {
	assert.equal(countMarkup("```\n{>>x<<}\n").total, 0);
});

test("findReceipt picks the newest receipt for the path since the run started", () => {
	const dir = mkdtempSync(join(tmpdir(), "margin-test-"));
	writeFileSync(join(dir, "a.json"), JSON.stringify({ path: "/doc.md", status: "done", finished_at: 100 }));
	writeFileSync(join(dir, "b.json"), JSON.stringify({ path: "/doc.md", status: "abandoned", finished_at: 200 }));
	writeFileSync(join(dir, "c.json"), JSON.stringify({ path: "/other.md", status: "done", finished_at: 300 }));
	writeFileSync(join(dir, "broken.json"), "{");
	assert.equal(findReceipt(dir, "/doc.md", 150).status, "abandoned");
	assert.equal(findReceipt(dir, "/doc.md", 250), null, "a stale receipt never satisfies a new run");
	assert.equal(findReceipt(join(dir, "missing"), "/doc.md", 0), null);
});

test("receiptsDir follows TERN_CONFIG_DIR, then the platform state dir", () => {
	assert.equal(receiptsDir({ TERN_CONFIG_DIR: "/x" }, "darwin"), "/x/plugin-data/margin/receipts");
	assert.match(receiptsDir({}, "darwin"), /Library\/Application Support\/Tern\/plugin-data\/margin\/receipts$/);
	assert.equal(receiptsDir({ XDG_STATE_HOME: "/s" }, "linux"), "/s/tern/plugin-data/margin/receipts");
});
