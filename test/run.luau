--!strict
-- Unit tests for lib/. Run with `npm test` (generates fixtures, then `luau test/run.luau`).

local blocks = require("../lib/blocks")
local critic = require("../lib/critic")
local model = require("../lib/model")
local fixtures = require("./fixtures.gen")

local failures = 0
local passes = 0

local function check(cond: boolean, msg: string)
	if cond then
		passes += 1
	else
		failures += 1
		print("FAIL: " .. msg)
	end
end

local function eq(a: any, b: any, msg: string)
	check(a == b, msg .. string.format(" (got %s, want %s)", tostring(a), tostring(b)))
end

local function fixture(name: string): string
	for _, f in fixtures do
		if f.name == name then
			return f.text
		end
	end
	error("no fixture " .. name)
end

-- 1. Structure of the edge-case fixture.
do
	local m = model.build(fixture("edge-cases.md"))
	local want = {
		"frontmatter", "heading", "heading", "paragraph", "list_item", "list_item", "list_item",
		"list_item", "list_item", "quote", "table", "code", "code", "html", "rule",
		"paragraph", "paragraph", "paragraph",
	}
	eq(#m.blocks, #want, "edge-cases block count")
	for i, k in want do
		local got = m.blocks[i] and m.blocks[i].kind or "nil"
		eq(got, k, "edge-cases block " .. i .. " kind")
	end
	eq(m.blocks[3].level, 1, "setext level")
	eq(#m.by_block[4], 2, "paragraph has inline and standalone comment")
	check(m.comments[m.by_block[4][2]].standalone, "second paragraph comment is standalone")
	eq(#m.by_block[12], 0, "no comments inside a fence")
	eq(#m.by_block[16], 1, "code-span comment ignored, real one found")
	eq(m.comments[m.by_block[16][1]].body, "real", "real comment body")
	eq(model.display(m, 17), "Paragraph with highlighted words.", "highlight unwrapped for display")
	eq(model.display(m, 4), "A paragraph that wraps\nacross two lines.", "display drops comments and attached paragraph")
	eq(m.blocks[6].last - m.blocks[6].first, 4, "bullet two spans nested items and loose paragraph")
	eq(m.blocks[5].anchor, m.blocks[5].first + 1, "lazy continuation is part of the first paragraph")
end

-- 1b. Fences inside list items, tables, task lists and setext headings.
do
	local m = model.build(fixture("guide.md"))
	eq(#m.blocks, 26, "guide block count")
	eq(m.blocks[11].kind, "list_item", "step with a fence is one list item")
	eq(m.blocks[11].last - m.blocks[11].first, 4, "the fence belongs to its list item")
	eq(m.blocks[11].anchor, m.blocks[11].first, "comment anchors to the item's text, not the fence")
	eq(m.blocks[8].kind, "table", "pipe table")
	eq(m.blocks[19].kind, "heading", "setext heading with dashes")
	eq(#m.comments, 0, "markup in fences and code spans is literal")
	-- A comment on a fenced list item followed directly by the next item
	-- stays attached, and deleting it restores the text.
	local added, padded = model.add_comment(m, 12, "step three note")
	local m2 = model.build(added)
	eq(#m2.by_block[12], 1, "comment lands on the fenced list item")
	eq(model.delete_comment(m2, m2.by_block[12][1], padded), fixture("guide.md"), "delete restores the guide")
end

-- 2. Every non-blank line belongs to exactly one block, in order.
local function coverage(name: string, text: string)
	local lines = blocks.lines(text)
	local owner = table.create(#lines, 0) :: { number }
	local prev_last = 0
	for bi, b in blocks.parse(text) do
		check(b.first > prev_last, name .. ": block " .. bi .. " starts after the previous one")
		check(b.first <= b.content_last and b.content_last <= b.last, name .. ": block " .. bi .. " ranges ordered")
		check(b.anchor >= b.first and b.anchor <= b.content_last, name .. ": block " .. bi .. " anchor in content")
		for l = b.first, b.last do
			owner[l] += 1
		end
		prev_last = b.last
	end
	for l, line in lines do
		if not string.match(line, "^%s*$") then
			eq(owner[l], 1, name .. ": line " .. l .. " owned once")
		end
	end
end
-- 3. Add, edit and delete restore the text byte for byte and keep blocks stable.
local function roundtrip(name: string, text: string)
	local m = model.build(text)
	for b = 1, #m.blocks do
		local before_display = model.display(m, b)
		local added, padded = model.add_comment(m, b, "Review note " .. b)
		local m2 = model.build(added)
		eq(#m2.blocks, #m.blocks, name .. ": block count stable after comment on " .. b)
		eq(#m2.by_block[b], #m.by_block[b] + 1, name .. ": comment lands on block " .. b)
		eq(model.display(m2, b), before_display, name .. ": display unchanged by comment on " .. b)
		local new_ci = -1
		for _, ci in m2.by_block[b] do
			if m2.comments[ci].body == "Review note " .. b then
				new_ci = ci
			end
		end
		check(new_ci > 0, name .. ": new comment found on block " .. b)
		if new_ci > 0 then
			local edited = model.build(model.edit_comment(m2, new_ci, "Changed"))
			eq(#edited.by_block[b], #m2.by_block[b], name .. ": edit keeps comment count on " .. b)
			eq(model.delete_comment(m2, new_ci, padded), text, name .. ": delete restores text for block " .. b)
		end
	end
end

for _, f in fixtures do
	coverage(f.name, f.text)
	roundtrip(f.name, f.text)
end

-- 4. CRLF files keep CRLF.
do
	local crlf = string.gsub(fixture("edge-cases.md"), "\n", "\r\n")
	coverage("edge-cases (crlf)", crlf)
	roundtrip("edge-cases (crlf)", crlf)
	local m = model.build(crlf)
	local added = model.add_comment(m, 11, "on table")
	check(string.find(added, "|\r\n\r\n{>>on table<<}\r\n", 1, true) ~= nil, "standalone comment uses CRLF")
end

-- 5. Sanitizing reviewer input.
eq(critic.sanitize("  hi  "), "hi", "sanitize trims")
eq(critic.sanitize("a <<} b"), "a << } b", "sanitize breaks closing delimiter")
eq(critic.sanitize("a {>> b"), "a { >> b", "sanitize breaks opening delimiter")
eq(critic.sanitize("one\n\n\ntwo"), "one\ntwo", "sanitize removes blank lines")
eq(critic.sanitize("one\r\ntwo"), "one\ntwo", "sanitize drops CR")

-- 6. ATX closing sequence stays last.
do
	local m = model.build("## Title ##\n")
	eq(model.add_comment(m, 1, "x"), "## Title{>>x<<} ##\n", "comment goes before closing hashes")
end

-- 7. Empty and comment-only documents.
eq(#model.build("").blocks, 0, "empty document has no blocks")
eq(#model.build("{>>only<<}\n").blocks, 1, "leading comment-only paragraph is its own block")

-- 7b. Findings from the pre-release review.
do
	-- An unclosed opener must not pair with a later comment's closer.
	local stray = "first para {>> oops never closed\n\nsecond para {>>real<<} tail\n"
	local spans = critic.find(stray)
	eq(#spans, 1, "stray opener is left as text")
	eq(spans[1].body, "real", "the real comment is still found")
	local m = model.build(stray)
	eq(#m.comments, 1, "model sees only the real comment")
	eq(model.delete_comment(m, 1), "first para {>> oops never closed\n\nsecond para  tail\n", "delete removes only the real comment")

	-- A blockquote ends at a heading or list; lazy text still continues it.
	local q = model.build("> quoted words\n# Real Heading\n\n> lazy\ncontinuation\n\n> q\n- item\n")
	local kinds = {}
	for _, b in q.blocks do
		table.insert(kinds, b.kind)
	end
	eq(table.concat(kinds, ","), "quote,heading,quote,quote,list_item", "quote boundaries")
	eq(q.blocks[3].last - q.blocks[3].first, 1, "lazy continuation stays in the quote")

	-- A code span that wraps a line hides comments on the next line.
	local span = model.build("a `code span\nstill code {>>not a comment<<} end` after{>>real<<}\n")
	eq(#span.comments, 1, "comment inside a wrapped code span is text")
	eq(span.comments[1].body, "real", "comment after the span is real")

	-- An inline tag at a line start does not split a paragraph; a block tag does.
	eq(#model.build("text\n<span>inline</span> more\n").blocks, 1, "inline tag continues the paragraph")
	eq(#model.build("text\n<div>\nblock\n</div>\n").blocks, 2, "block tag interrupts the paragraph")

	-- add_comment reports where the new comment starts, even when later blocks
	-- already have comments (the index of the new comment is then lower).
	local base = model.build("para one\n\np2 {>>a<<}\n\n| a | b |\n| - | - |\n| 1 | 2 |\nnext line\n")
	local t1, _, at1 = model.add_comment(base, 1, "new")
	local m1 = model.build(t1)
	eq(m1.comments[1].s, at1, "inline offset identifies the new comment")
	local tb = 0
	for i, b in base.blocks do
		if b.kind == "table" then
			tb = i
		end
	end
	local t2, padded, at2 = model.add_comment(base, tb, "on table")
	local m2 = model.build(t2)
	local found = false
	for _, c in m2.comments do
		if c.s == at2 and c.body == "on table" then
			found = true
		end
	end
	check(found, "standalone offset identifies the new comment")
	check(padded, "table followed by text gets a padding line")
end

-- 8. The composer's text editing.
do
	local editor = require("../lib/editor")
	local function key(name: string, opts: any?): any
		local o: any = opts or {}
		return { name = name, text = o.text, ctrl = o.ctrl == true, alt = o.alt == true, shift = o.shift == true, meta = o.meta == true }
	end
	local e = editor.new("")
	for _, ch in { "h", "é", "y" } do
		editor.key(e, key(ch, { text = ch }))
	end
	eq(e.text, "héy", "typing inserts characters")
	editor.key(e, key("left"))
	editor.key(e, key("left"))
	eq(e.cursor, 1, "left steps over a two-byte character")
	eq(editor.utf16(e.text, #e.text), 3, "utf16 counts characters")
	editor.key(e, key("delete"))
	eq(e.text, "hy", "delete removes the whole character")
	editor.key(e, key("z", { meta = true }))
	eq(e.text, "héy", "undo restores")
	local w = editor.new("one two three")
	editor.key(w, key("backspace", { alt = true }))
	eq(w.text, "one two ", "alt+backspace deletes a word")
	editor.key(w, key("backspace", { meta = true }))
	eq(w.text, "", "cmd+backspace deletes to line start")
	editor.key(w, key("paste", { text = "a\r\nb" }))
	eq(w.text, "a\nb", "paste normalizes line endings")
	check(not editor.key(w, key("f5")), "unused keys report no change")
end

print(string.format("%d passed, %d failed", passes, failures))
if failures > 0 then
	error("tests failed")
end
