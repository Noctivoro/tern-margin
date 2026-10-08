--!strict
-- Splits Markdown source into top-level blocks with one-based, inclusive
-- source line ranges. Pure: no `tern` calls, so the standalone Luau runtime
-- can test it.
--
-- Invariants:
--   * blocks are in source order and never overlap;
--   * every non-blank line belongs to exactly one block;
--   * a paragraph made only of CriticMarkup comments attaches to the block
--     before it (that block's `last` grows; `content_last` does not), so
--     adding a standalone comment never changes the block count.

local critic = require("./critic")

export type Kind = "frontmatter" | "heading" | "paragraph" | "list_item" | "quote"
	| "table" | "code" | "html" | "rule"

export type Block = {
	kind: Kind,
	first: number,
	-- Last line of the block's own content.
	content_last: number,
	-- Last line including attached comment-only paragraphs.
	last: number,
	-- Heading level, when `kind` is "heading".
	level: number?,
	-- Line holding the text an inline comment attaches to.
	anchor: number,
}

local M = {}

-- Splits on "\n" exactly; a trailing newline gives a final empty line.
function M.lines(text: string): { string }
	local out = {}
	local start = 1
	while true do
		local nl = string.find(text, "\n", start, true)
		if nl == nil then
			table.insert(out, string.sub(text, start))
			break
		end
		table.insert(out, string.sub(text, start, nl - 1))
		start = nl + 1
	end
	return out
end

local function blank(line: string): boolean
	return string.match(line, "^%s*$") ~= nil
end

local function indent(line: string): number
	local spaces = 0
	for i = 1, #line do
		local c = string.sub(line, i, i)
		if c == " " then
			spaces += 1
		elseif c == "\t" then
			spaces += 4 - (spaces % 4)
		else
			break
		end
	end
	return spaces
end

local function strip_cr(line: string): string
	if string.sub(line, -1) == "\r" then
		return string.sub(line, 1, -2)
	end
	return line
end

local function fence_open(line: string): (string?, number)
	if indent(line) > 3 then
		return nil, 0
	end
	local run = string.match(line, "^%s*(```+)") or string.match(line, "^%s*(~~~+)")
	if run == nil then
		return nil, 0
	end
	-- A backtick fence's info string cannot contain backticks.
	local lead = string.match(line, "^%s*") or ""
	if string.sub(run, 1, 1) == "`" and string.find(string.sub(line, #lead + #run + 1), "`", 1, true) then
		return nil, 0
	end
	return string.sub(run, 1, 1), #run
end

local function fence_close(line: string, ch: string, len: number): boolean
	if indent(line) > 3 then
		return false
	end
	local run = string.match(line, "^%s*(" .. (if ch == "`" then "```+" else "~~~+") .. ")%s*$")
	return run ~= nil and #run >= len
end

local function atx(line: string): number?
	if indent(line) > 3 then
		return nil
	end
	local hashes = string.match(line, "^%s*(#+)%s") or string.match(line, "^%s*(#+)$")
	if hashes ~= nil and #hashes <= 6 then
		return #hashes
	end
	return nil
end

local function thematic(line: string): boolean
	if indent(line) > 3 then
		return false
	end
	local s = string.gsub(line, "%s", "")
	if #s < 3 then
		return false
	end
	local c = string.sub(s, 1, 1)
	if c ~= "-" and c ~= "*" and c ~= "_" then
		return false
	end
	return string.match(s, "^%" .. c .. "+$") ~= nil
end

local function setext(line: string): number?
	if indent(line) > 3 then
		return nil
	end
	if string.match(line, "^%s*=+%s*$") then
		return 1
	end
	if string.match(line, "^%s*%-+%s*$") then
		return 2
	end
	return nil
end

-- A list marker: returns the marker's indent and the content column.
local function list_marker(line: string): (number?, number)
	local lead = string.match(line, "^( *)") or ""
	if #lead > 3 then
		return nil, 0
	end
	local rest = string.sub(line, #lead + 1)
	local marker: string? = string.match(rest, "^([%-%+%*])%s") or string.match(rest, "^([%-%+%*])$")
	if marker == nil then
		marker = string.match(rest, "^(%d%d?%d?%d?%d?%d?%d?%d?%d?[%.%)])%s")
			or string.match(rest, "^(%d%d?%d?%d?%d?%d?%d?%d?%d?[%.%)])$")
	end
	if marker == nil then
		return nil, 0
	end
	local mlen = #(marker :: string)
	local after = string.sub(rest, mlen + 1)
	local gap = #(string.match(after, "^( *)") or "")
	if gap == 0 or gap > 4 or blank(after) then
		gap = 1
	end
	return #lead, #lead + mlen + gap
end

local function quote_line(line: string): boolean
	return indent(line) <= 3 and string.match(line, "^%s*>") ~= nil
end

local function html_line(line: string): boolean
	return indent(line) <= 3 and string.match(line, "^%s*<[%a!/%?]") ~= nil
end

-- CommonMark HTML block types 1-6, the only ones that interrupt a paragraph.
-- An inline tag such as `<span>` at the start of a line (type 7) does not.
local HTML_BLOCK_TAGS = {}
for tag in string.gmatch("address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul pre script style textarea", "%S+") do
	HTML_BLOCK_TAGS[tag] = true
end

local function html_interrupts(line: string): boolean
	if not html_line(line) then
		return false
	end
	local rest = string.match(line, "^%s*<(.*)$") or ""
	if string.match(rest, "^[!?]") then
		return true -- comments, processing instructions, declarations, CDATA
	end
	local tag = string.match(rest, "^/?(%a[%w%-]*)")
	return tag ~= nil and HTML_BLOCK_TAGS[string.lower(tag)] == true
end

local function table_delim(line: string): boolean
	local s = string.gsub(line, "%s", "")
	if not string.find(s, "-", 1, true) then
		return false
	end
	local had_pipe = string.find(s, "|", 1, true) ~= nil
	s = string.gsub(string.gsub(s, "^|", ""), "|$", "")
	if s == "" then
		return false
	end
	local cells = 0
	for cell in string.gmatch(s .. "|", "([^|]*)|") do
		if not string.match(cell, "^:?%-+:?$") then
			return false
		end
		cells += 1
	end
	-- One column without pipes would be a setext underline or a rule.
	return had_pipe or cells > 1
end

-- Whether `line` starts a block that interrupts a paragraph.
local function interrupts(line: string): boolean
	if atx(line) or thematic(line) or quote_line(line) or html_interrupts(line) then
		return true
	end
	if (fence_open(line)) ~= nil then
		return true
	end
	local mi = list_marker(line)
	if mi ~= nil then
		-- Only bullets and lists starting at 1 interrupt a paragraph, and
		-- never with an empty item.
		local rest = string.sub(line, mi + 1)
		local num = string.match(rest, "^(%d+)[%.%)]")
		local body = string.match(rest, "^%S+%s+(.*)$")
		return (num == nil or num == "1") and body ~= nil and not blank(body)
	end
	return false
end

local function comment_only(lines: { string }, first: number, last: number): boolean
	local parts = {}
	for i = first, last do
		table.insert(parts, lines[i])
	end
	local text = table.concat(parts, "\n")
	if not string.find(text, "{>>", 1, true) then
		return false
	end
	return blank(critic.strip_comments(text))
end

function M.parse(text: string): { Block }
	local raw = M.lines(text)
	local lines = table.create(#raw) :: { string }
	for i, l in raw do
		lines[i] = strip_cr(l)
	end
	local n = #lines
	local out: { Block } = {}
	local i = 1

	local function push(kind: Kind, first: number, last: number, anchor: number, level: number?)
		table.insert(out, { kind = kind, first = first, content_last = last, last = last, anchor = anchor, level = level })
	end

	-- Front matter: "---" on line 1 closed by "---" or "...".
	if n > 1 and lines[1] == "---" then
		for j = 2, n do
			if lines[j] == "---" or lines[j] == "..." then
				push("frontmatter", 1, j, j)
				i = j + 1
				break
			end
		end
	end

	while i <= n do
		local line = lines[i]
		if blank(line) then
			i += 1
			continue
		end

		local ch, len = fence_open(line)
		if ch ~= nil then
			local j = i + 1
			while j <= n and not fence_close(lines[j], ch, len) do
				j += 1
			end
			local last = math.min(j, n)
			push("code", i, last, last)
			i = last + 1
			continue
		end

		local level = atx(line)
		if level ~= nil then
			push("heading", i, i, i, level)
			i += 1
			continue
		end

		if thematic(line) then
			push("rule", i, i, i)
			i += 1
			continue
		end

		if html_line(line) then
			local j = i
			while j + 1 <= n and not blank(lines[j + 1]) do
				j += 1
			end
			push("html", i, j, j)
			i = j + 1
			continue
		end

		if quote_line(line) then
			local j = i
			-- Lazy continuation only carries paragraph text: a heading, list,
			-- fence, rule or HTML block after the quote starts a new block.
			while j + 1 <= n and not blank(lines[j + 1]) and (quote_line(lines[j + 1]) or not interrupts(lines[j + 1])) do
				j += 1
			end
			push("quote", i, j, j)
			i = j + 1
			continue
		end

		local mi, content_col = list_marker(line)
		if mi ~= nil then
			-- The item runs until a blank line followed by a line indented
			-- less than its content, or a sibling marker at its indent.
			local j = i
			local para_end = i -- last line of the item's first paragraph
			local in_first_para = true
			while j + 1 <= n do
				local nxt = lines[j + 1]
				if blank(nxt) then
					local k = j + 1
					while k <= n and blank(lines[k]) do
						k += 1
					end
					if k > n or indent(lines[k]) < content_col then
						break
					end
					in_first_para = false
					j = k
					continue
				end
				local nmi = list_marker(nxt)
				if nmi ~= nil and nmi <= mi then
					break
				end
				if indent(nxt) < content_col then
					-- Lazy continuation only for paragraph text.
					if nmi ~= nil or interrupts(nxt) or not in_first_para then
						break
					end
				end
				if in_first_para and (nmi ~= nil or (fence_open(nxt)) ~= nil) then
					in_first_para = false
				end
				j += 1
				if in_first_para then
					para_end = j
				end
			end
			push("list_item", i, j, para_end)
			i = j + 1
			continue
		end

		-- Table: a header row followed by a delimiter row.
		if string.find(line, "|", 1, true) and i + 1 <= n and table_delim(lines[i + 1]) then
			local j = i + 1
			while j + 1 <= n and not blank(lines[j + 1]) and string.find(lines[j + 1], "|", 1, true) do
				j += 1
			end
			push("table", i, j, j)
			i = j + 1
			continue
		end

		-- Paragraph, possibly a setext heading.
		local j = i
		local heading_level: number? = nil
		while j + 1 <= n do
			local nxt = lines[j + 1]
			if blank(nxt) then
				break
			end
			local sl = setext(nxt)
			if sl ~= nil then
				heading_level = sl
				j += 1
				break
			end
			if interrupts(nxt) then
				break
			end
			j += 1
		end
		if heading_level ~= nil then
			push("heading", i, j, j - 1, heading_level)
		elseif #out > 0 and comment_only(lines, i, j) then
			out[#out].last = j
		else
			push("paragraph", i, j, j)
		end
		i = j + 1
	end
	return out
end

return M
