--!strict
-- The review document: blocks, the comments attached to them, and the text
-- edits that add, change and remove comments. Pure: no `tern` calls.
--
-- Every edit touches only the bytes of one comment (plus the line breaks a
-- standalone comment brought with it), so adding and then deleting a comment
-- restores the original text byte for byte.

local blocks = require("./blocks")
local critic = require("./critic")

export type Comment = {
	block: number,
	s: number,
	e: number,
	body: string,
	-- True when the comment sits alone in its own paragraph.
	standalone: boolean,
}

export type Model = {
	text: string,
	-- Byte offset where each one-based line starts.
	line_start: { number },
	line_len: { number },
	nl: string,
	blocks: { blocks.Block },
	comments: { Comment },
	-- Comment indexes per block, in source order.
	by_block: { { number } },
}

local M = {}

local INLINE = { paragraph = true, heading = true, list_item = true, quote = true }
local LITERAL = { code = true, frontmatter = true, html = true }

local function line_of(m: Model, offset: number): number
	local lo, hi = 1, #m.line_start
	while lo < hi do
		local mid = (lo + hi + 1) // 2
		if m.line_start[mid] <= offset then
			lo = mid
		else
			hi = mid - 1
		end
	end
	return lo
end

-- Byte offset just past the line's last character, before any "\r".
local function line_end(m: Model, line: number): number
	local s = m.line_start[line]
	local len = m.line_len[line]
	if len > 0 and string.sub(m.text, s + len - 1, s + len - 1) == "\r" then
		len -= 1
	end
	return s + len
end

-- Whether `offset` falls inside a backtick code span. Code spans can wrap
-- lines, so count from `from`, the start of the paragraph holding `offset`,
-- ignoring backticks inside earlier comments.
local function in_code_span(m: Model, from: number, offset: number): boolean
	local before = critic.strip_comments(string.sub(m.text, from, offset - 1))
	local _, ticks = string.gsub(before, "`", "")
	return ticks % 2 == 1
end

function M.build(text: string): Model
	local raw = blocks.lines(text)
	local line_start, line_len = table.create(#raw) :: { number }, table.create(#raw) :: { number }
	local pos = 1
	for i, l in raw do
		line_start[i] = pos
		line_len[i] = #l
		pos += #l + 1
	end
	local nl = if string.find(text, "\r\n", 1, true) then "\r\n" else "\n"
	local m: Model = {
		text = text,
		line_start = line_start,
		line_len = line_len,
		nl = nl,
		blocks = blocks.parse(text),
		comments = {},
		by_block = {},
	}
	for b = 1, #m.blocks do
		m.by_block[b] = {}
	end
	local bi = 1
	for _, sp in critic.find(text) do
		local line = line_of(m, sp.s)
		while bi <= #m.blocks and m.blocks[bi].last < line do
			bi += 1
		end
		local blk = m.blocks[bi]
		if blk == nil or line < blk.first then
			continue
		end
		if LITERAL[blk.kind] and line <= blk.content_last then
			continue
		end
		local para_first = if line > blk.content_last then blk.content_last + 1 else blk.first
		if in_code_span(m, m.line_start[para_first], sp.s) then
			continue
		end
		local standalone = line > blk.content_last
		table.insert(m.comments, { block = bi, s = sp.s, e = sp.e, body = sp.body, standalone = standalone })
		table.insert(m.by_block[bi], #m.comments)
	end
	return m
end

-- The block's Markdown as a reader should see it: comments removed,
-- highlight markers unwrapped, trailing blank lines dropped, front matter
-- shown as a YAML code block instead of a rule and a setext heading.
function M.display(m: Model, b: number): string
	local blk = m.blocks[b]
	if blk.kind == "frontmatter" then
		local s = m.line_start[blk.first + 1]
		local e = m.line_start[blk.content_last] - 2
		local inner = if blk.content_last > blk.first + 1 then string.sub(m.text, s, e) else ""
		return "```yaml\n" .. string.gsub(inner, "\r", "") .. "\n```"
	end
	local s = m.line_start[blk.first]
	local e = m.line_start[blk.last] + m.line_len[blk.last] - 1
	local parts = {}
	local pos = s
	for _, ci in m.by_block[b] do
		local c = m.comments[ci]
		table.insert(parts, string.sub(m.text, pos, c.s - 1))
		pos = c.e + 1
	end
	table.insert(parts, string.sub(m.text, pos, e))
	local out = table.concat(parts)
	if not LITERAL[blk.kind] then
		out = critic.unwrap_highlights(out)
	end
	out = string.gsub(out, "[ \t\r\n]+$", "")
	return out
end

local function splice(text: string, from: number, to: number, insert: string): string
	return string.sub(text, 1, from - 1) .. insert .. string.sub(text, to + 1)
end

-- Text with a new comment on block `b`. `body` must already be sanitized.
-- Also returns:
--   * whether a standalone comment needed a blank line after it (the block
--     ran straight into the next line). Pass it back to `delete_comment` to
--     restore the text byte for byte; the text alone cannot tell that case
--     apart from a comment that already had a blank line after it;
--   * the byte offset of the new comment's `{` in the returned text, which
--     identifies it in the rebuilt model.
function M.add_comment(m: Model, b: number, body: string): (string, boolean, number)
	local blk = m.blocks[b]
	local span = critic.wrap(body)
	if INLINE[blk.kind] then
		local at = line_end(m, blk.anchor)
		if blk.kind == "heading" and blk.anchor == blk.first then
			-- Keep an ATX closing sequence ("## Title ##") last on the line.
			local line = string.sub(m.text, m.line_start[blk.anchor], at - 1)
			local closing = string.match(line, "%s+#+%s*$")
			if closing then
				at -= #closing
			end
		end
		return splice(m.text, at, at - 1, span), false, at
	end
	local at = line_end(m, blk.last)
	local next_line = blk.last + 1
	local pad = m.line_start[next_line] ~= nil
		and string.match(string.sub(m.text, m.line_start[next_line], m.line_start[next_line] + m.line_len[next_line] - 1), "^%s*$") == nil
	local insert = m.nl .. m.nl .. span .. (if pad then m.nl else "")
	return splice(m.text, at, at - 1, insert), pad, at + 2 * #m.nl
end

function M.edit_comment(m: Model, ci: number, body: string): string
	local c = m.comments[ci]
	return splice(m.text, c.s, c.e, critic.wrap(body))
end

-- `padded`: the second result `add_comment` returned for this comment.
function M.delete_comment(m: Model, ci: number, padded: boolean?): string
	local c = m.comments[ci]
	local from, to = c.s, c.e
	if c.standalone then
		local lead = m.nl .. m.nl
		local after = string.sub(m.text, to + 1, to + #m.nl)
		if string.sub(m.text, from - #lead, from - 1) == lead and (after == m.nl or after == "") then
			from -= #lead
			if padded and string.sub(m.text, to + 1, to + 2 * #m.nl) == lead then
				to += #m.nl
			end
		end
	end
	return splice(m.text, from, to, "")
end

return M
