--!strict
-- CriticMarkup comment helpers. Pure: no `tern` calls.

local M = {}

export type Span = {
	-- Byte offset of the opening "{" of "{>>".
	s: number,
	-- Byte offset of the closing "}" of "<<}".
	e: number,
	body: string,
}

-- Every `{>>…<<}` span in `text`, in order. A comment never spans a blank
-- line (`sanitize` guarantees it for comments Margin writes), so an opener
-- with no closer before the next blank line is left as text. Without that
-- bound, a stray `{>>` would pair with a later comment's `<<}` and deleting
-- the "comment" would erase everything between them.
function M.find(text: string): { Span }
	local out: { Span } = {}
	local pos = 1
	while true do
		local s = string.find(text, "{>>", pos, true)
		if s == nil then
			break
		end
		local close = string.find(text, "<<}", s + 3, true)
		local para_end = string.find(text, "\n[ \t\r]*\n", s + 3)
		if close == nil or (para_end ~= nil and para_end < close) then
			pos = s + 3
			continue
		end
		table.insert(out, { s = s, e = close + 2, body = string.sub(text, s + 3, close - 1) })
		pos = close + 3
	end
	return out
end

-- `text` with every comment span removed.
function M.strip_comments(text: string): string
	local out = {}
	local pos = 1
	for _, sp in M.find(text) do
		table.insert(out, string.sub(text, pos, sp.s - 1))
		pos = sp.e + 1
	end
	table.insert(out, string.sub(text, pos))
	return table.concat(out)
end

-- Removes highlight markers, keeping the highlighted text: `{==x==}` -> `x`.
function M.unwrap_highlights(text: string): string
	return (string.gsub(text, "{==(.-)==}", "%1"))
end

-- Makes reviewer text safe to store inside `{>>…<<}`: no closing or opening
-- delimiter, no carriage returns, no blank lines (a blank line would end the
-- paragraph the comment sits in), no surrounding whitespace.
function M.sanitize(body: string): string
	local s = string.gsub(body, "\r", "")
	s = string.gsub(s, "<<}", "<< }")
	s = string.gsub(s, "{>>", "{ >>")
	s = string.gsub(s, "\n[ \t]*\n[%s]*", "\n")
	s = string.match(s, "^%s*(.-)%s*$") or ""
	return s
end

function M.wrap(body: string): string
	return "{>>" .. body .. "<<}"
end

return M
