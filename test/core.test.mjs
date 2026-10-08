import { test } from "node:test";
import assert from "node:assert/strict";
import { countMarkup } from "../cli/core.mjs";

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
