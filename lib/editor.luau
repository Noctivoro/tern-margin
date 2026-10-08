--!strict
-- A small text field the block owns: Tern draws the `editor` node, every key
-- reaches the block (plugin blocks get no native editing), and this module
-- applies it. `cursor` is a byte offset into `text` (0 = before the first
-- byte) that always sits on a UTF-8 character boundary.

export type Editor = {
	text: string,
	cursor: number,
	undo: { { text: string, cursor: number } },
}

-- Key shape as Tern delivers it to a block's `key` handler.
type KeyLike = { name: string, text: string?, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }

local M = {}

local MAX_UNDO = 200

function M.new(text: string): Editor
	return { text = text, cursor = #text, undo = {} }
end

local function prev_char(s: string, i: number): number
	if i <= 0 then
		return 0
	end
	local start = utf8.offset(s, -1, i + 1)
	return if start then start - 1 else i - 1
end

local function next_char(s: string, i: number): number
	if i >= #s then
		return #s
	end
	local nxt = utf8.offset(s, 2, i + 1)
	return if nxt then nxt - 1 else #s
end

local function is_space(c: string): boolean
	return c == " " or c == "\t" or c == "\n"
end

local function prev_word(s: string, i: number): number
	local j = i
	while j > 0 and is_space(string.sub(s, j, j)) do
		j -= 1
	end
	while j > 0 and not is_space(string.sub(s, j, j)) do
		j -= 1
	end
	return j
end

local function next_word(s: string, i: number): number
	local j = i
	while j < #s and is_space(string.sub(s, j + 1, j + 1)) do
		j += 1
	end
	while j < #s and not is_space(string.sub(s, j + 1, j + 1)) do
		j += 1
	end
	return j
end

local function line_start(s: string, i: number): number
	local j = i
	while j > 0 and string.sub(s, j, j) ~= "\n" do
		j -= 1
	end
	return j
end

local function line_end(s: string, i: number): number
	local j = i
	while j < #s and string.sub(s, j + 1, j + 1) ~= "\n" do
		j += 1
	end
	return j
end

local function snapshot(e: Editor)
	table.insert(e.undo, { text = e.text, cursor = e.cursor })
	if #e.undo > MAX_UNDO then
		table.remove(e.undo, 1)
	end
end

local function replace(e: Editor, from: number, to: number, insert: string)
	snapshot(e)
	e.text = string.sub(e.text, 1, from) .. insert .. string.sub(e.text, to + 1)
	e.cursor = from + #insert
end

-- Applies one key. Returns false when the key changed nothing.
function M.key(e: Editor, k: KeyLike): boolean
	local name, s, c = k.name, e.text, e.cursor
	local word = k.alt
	local line = k.meta
	if (k.ctrl or k.meta) and name == "z" then
		local last = table.remove(e.undo)
		if last == nil then
			return false
		end
		e.text, e.cursor = last.text, last.cursor
		return true
	end
	-- Terminal kill keys: ⌃U to line start, ⌃K to line end, ⌃W a word back.
	-- ⌘⌫ may be taken by the window's own bindings; these always arrive.
	if k.ctrl and (name == "u" or name == "k" or name == "w") then
		local from, to = c, c
		if name == "u" then
			from = line_start(s, c)
		elseif name == "k" then
			to = line_end(s, c)
		else
			from = prev_word(s, c)
		end
		if from == to then
			return false
		end
		replace(e, from, to, "")
		return true
	end
	if name == "paste" and k.text then
		replace(e, c, c, (string.gsub(k.text, "\r\n?", "\n")))
		return true
	end
	if name == "enter" then
		replace(e, c, c, "\n")
		return true
	end
	if name == "backspace" then
		if c == 0 then
			return false
		end
		local from = if line then line_start(s, c) elseif word then prev_word(s, c) else prev_char(s, c)
		if from == c then
			from = prev_char(s, c)
		end
		replace(e, from, c, "")
		return true
	end
	if name == "delete" then
		if c >= #s then
			return false
		end
		local to = if word then next_word(s, c) else next_char(s, c)
		replace(e, c, to, "")
		return true
	end
	if name == "left" then
		e.cursor = if line then line_start(s, c) elseif word then prev_word(s, c) else prev_char(s, c)
		return e.cursor ~= c
	end
	if name == "right" then
		e.cursor = if line then line_end(s, c) elseif word then next_word(s, c) else next_char(s, c)
		return e.cursor ~= c
	end
	if name == "home" or (k.ctrl and name == "a") then
		e.cursor = line_start(s, c)
		return e.cursor ~= c
	end
	if name == "end" or (k.ctrl and name == "e") then
		e.cursor = line_end(s, c)
		return e.cursor ~= c
	end
	if name == "up" then
		e.cursor = if k.meta then 0 else line_start(s, c)
		return e.cursor ~= c
	end
	if name == "down" then
		e.cursor = if k.meta then #s else line_end(s, c)
		return e.cursor ~= c
	end
	if k.text and k.text ~= "" and not k.ctrl and not k.meta then
		replace(e, c, c, k.text)
		return true
	end
	return false
end

-- The UTF-16 offset of byte offset `i`, for the editor node's `cursor` prop.
-- Invalid UTF-8 (possible in a comment read from disk) counts bytes.
function M.utf16(s: string, i: number): number
	local n = 0
	local ok = pcall(function()
		for _, cp in utf8.codes(string.sub(s, 1, i)) do
			n += if cp > 0xFFFF then 2 else 1
		end
	end)
	return if ok then n else i
end

return M
