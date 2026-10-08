--!strict
-- The Margin review block: renders a Markdown file block by block, shows
-- CriticMarkup comments under the block they belong to, and adds, edits and
-- deletes comments in the file. Finishing writes a receipt that agents read
-- (see bin/margin.mjs), because a block can restart without the reviewer
-- finishing.

local ui = tern.ui
local model = require("./lib/model")
local critic = require("./lib/critic")
local editor = require("./lib/editor")

local MAX_BYTES = 4 * 1024 * 1024
local POLL_MS = 1000

type Mode = "browse" | "compose" | "edit" | "confirm"

type State = {
	path: string,
	started: number,
	text: string,
	m: model.Model,
	error: string?,
	sel: number,
	-- Selected comment (an index into m.comments), always on block `sel`.
	csel: number?,
	mode: Mode,
	ed: editor.Editor,
	-- Standalone comments added this session that brought a blank line after
	-- them, by the byte offset of their `{`. Kept in step with every save;
	-- cleared when the file changes on disk; never saved across restarts, so
	-- a stale offset can never make a delete remove the wrong line break.
	padded: { [number]: boolean },
	stale: boolean,
	finished: boolean,
	help: boolean,
	status: string?,
}

local function basename(path: string): string
	return string.match(path, "[^/]+$") or path
end

local function running(pane: number): boolean
	for _, p in tern.pane.list() do
		if p.pane == pane then
			return true
		end
	end
	return false
end

-- FNV-1a, 32-bit: a stable receipt file name for a path.
local function fnv(s: string): string
	local h = 0x811c9dc5
	for i = 1, #s do
		h = bit32.bxor(h, string.byte(s, i))
		h = (h * 0x01000193) % 0x100000000
	end
	return string.format("%08x", h)
end

-- `tern.fs.read` with a size cap refuses symlinks, so a symlinked review file
-- is read uncapped and checked afterwards.
local function read_file(path: string): (string?, string?)
	local ok, res = pcall(tern.fs.read, path, MAX_BYTES)
	if ok then
		return res :: string, nil
	end
	local ok2, res2 = pcall(tern.fs.read, path)
	if not ok2 then
		return nil, tostring(res)
	end
	if #(res2 :: string) > MAX_BYTES then
		return nil, "the file is larger than 4 MiB"
	end
	return res2 :: string, nil
end

local function clamp_selection(state: State)
	local n = #state.m.blocks
	if state.sel > n then
		state.sel = n
	end
	if state.sel < 1 and n > 0 then
		state.sel = 1
	end
	local c = if state.csel then state.m.comments[state.csel] else nil
	if c == nil or c.block ~= state.sel then
		state.csel = nil
	end
end

local function apply_text(state: State, text: string)
	state.text = text
	state.m = model.build(text)
	state.error = nil
	clamp_selection(state)
end

-- Loads the file from disk. Offsets of padded comments only survive the
-- review's own saves, so any other change to the text drops them.
local function load(state: State)
	local text, err = read_file(state.path)
	if text == nil then
		state.error = err
		state.text = ""
		state.m = model.build("")
		state.padded = {}
		return
	end
	if text ~= state.text then
		state.padded = {}
	end
	apply_text(state, text)
end

local function after_render(fn: () -> ())
	tern.timer(0, function()
		fn()
	end)
end

-- Scrolls the selection into view. `ahead` (1 or -1) reveals the next block
-- in the direction of travel instead, so stepping through the document keeps
-- one block of context visible past the selection.
local function reveal(state: State, cx: BlockCx, ahead: number?)
	local id: string
	if ahead then
		id = "main.doc.b" .. math.clamp(state.sel + ahead, 1, math.max(#state.m.blocks, 1))
	else
		id = "main.doc.b" .. state.sel
		if state.csel then
			id ..= ".c" .. state.csel
		end
	end
	after_render(function()
		cx:frame({ { "reveal", id, "nearest" } })
	end)
end

local function focus_composer(cx: BlockCx)
	after_render(function()
		cx:frame({ { "focus", "dock.composer" } })
	end)
end

local function write_receipt(state: State, status: string)
	local dir = tern.plugin.data .. "/receipts"
	tern.fs.mkdir(dir)
	tern.fs.write(dir .. "/" .. fnv(state.path) .. ".json", tern.json.encode({
		version = 1,
		path = state.path,
		status = status,
		comments = #state.m.comments,
		started_at = state.started,
		finished_at = os.time(),
	}, true))
end

-- Moves the padded offsets past the first byte that differs between `old`
-- and `new`, so they keep pointing at the same comments after a save.
local function shift_padded(state: State, old: string, new: string)
	if next(state.padded) == nil then
		return
	end
	local common = 0
	local limit = math.min(#old, #new)
	while common < limit and string.byte(old, common + 1) == string.byte(new, common + 1) do
		common += 1
	end
	local delta = #new - #old
	local moved = {}
	for s in state.padded do
		moved[if s > common then s + delta else s] = true
	end
	state.padded = moved
end

-- Writes `text` if the file still holds what the review last loaded.
-- Returns false (and reloads) when the file changed underneath.
--
-- The write is in place, not a temp file and a rename: a rename would replace
-- a symlink with a plain file and reset the file's mode, and review files are
-- small enough that a torn write is not a practical risk. The write is
-- synchronous, so the poll never sees a half-finished save.
local function commit(state: State, cx: BlockCx, text: string): boolean
	local disk, err = read_file(state.path)
	if disk == nil then
		cx:toast("error", "Could not read " .. basename(state.path), err)
		return false
	end
	if disk ~= state.text then
		state.padded = {}
		apply_text(state, disk)
		cx:toast("error", "The file changed outside the review", "Reloaded it. Your comment is still in the box.")
		return false
	end
	local ok, werr = pcall(tern.fs.write, state.path, text)
	if not ok then
		cx:toast("error", "Could not save " .. basename(state.path), tostring(werr))
		state.padded = {}
		load(state)
		return false
	end
	shift_padded(state, state.text, text)
	apply_text(state, text)
	state.status = "Saved"
	return true
end

local function select_block(state: State, b: number)
	if #state.m.blocks == 0 then
		return
	end
	state.sel = math.clamp(b, 1, #state.m.blocks)
	state.csel = nil
end

-- Moves through every comment in the document; `dir` is 1 or -1.
local function cycle_comment(state: State, dir: number)
	local n = #state.m.comments
	if n == 0 then
		return
	end
	local cur = state.csel
	local nxt: number
	if cur == nil then
		-- Start from the first comment at or after (before) the selected block.
		nxt = if dir > 0 then 1 else n
		for ci, c in state.m.comments do
			if dir > 0 and c.block >= state.sel then
				nxt = ci
				break
			end
			if dir < 0 and c.block <= state.sel then
				nxt = ci
			end
		end
	else
		nxt = ((cur - 1 + dir) % n) + 1
	end
	state.csel = nxt
	state.sel = state.m.comments[nxt].block
end

local function start_compose(state: State, cx: BlockCx, mode: Mode, text: string)
	state.mode = mode
	state.ed = editor.new(text)
	state.status = nil
	focus_composer(cx)
end

local function submit(state: State, cx: BlockCx)
	local body = critic.sanitize(state.ed.text)
	if body == "" then
		if state.mode == "edit" and state.csel then
			state.mode = "confirm"
		else
			state.mode = "browse"
		end
		return
	end
	if state.mode == "compose" then
		local text, padded, at = model.add_comment(state.m, state.sel, body)
		if commit(state, cx, text) then
			state.mode = "browse"
			for ci, c in state.m.comments do
				if c.s == at then
					state.csel = ci
				end
			end
			if padded then
				state.padded[at] = true
			end
		end
	elseif state.mode == "edit" and state.csel then
		local ci = state.csel
		if commit(state, cx, model.edit_comment(state.m, ci, body)) then
			state.mode = "browse"
			state.csel = ci
		end
	end
end

local function delete_selected(state: State, cx: BlockCx)
	local ci = state.csel
	if ci == nil then
		state.mode = "browse"
		return
	end
	local at = state.m.comments[ci].s
	local padded = state.padded[at]
	state.padded[at] = nil
	if commit(state, cx, model.delete_comment(state.m, ci, padded)) then
		state.csel = nil
		state.status = "Comment deleted"
	end
	state.mode = "browse"
end

local function finish(state: State, cx: BlockCx, status: string)
	if state.finished then
		return
	end
	state.finished = true
	write_receipt(state, status)
	cx:exit(0)
end

local function poll(state: State, cx: BlockCx)
	if state.finished or not running(cx.pane) then
		return
	end
	do
		local disk = read_file(state.path)
		if disk ~= nil and disk ~= state.text then
			if state.mode == "browse" or state.mode == "confirm" then
				state.padded = {}
				apply_text(state, disk)
				state.mode = "browse"
				state.status = "Reloaded: the file changed on disk"
				cx:render()
			else
				state.stale = true
			end
		end
	end
	tern.timer(POLL_MS, function()
		poll(state, cx)
	end)
end

-- View ----------------------------------------------------------------------

local function comment_node(state: State, ci: number): Node
	local c = state.m.comments[ci]
	local selected = state.csel == ci
	return ui.node("col", {
		key = "c" .. ci,
		role = "margin.comment",
		tone = if selected then "accent" else nil,
		actions = { click = "com=" .. ci, dblclick = "editcom=" .. ci },
	}, {
		ui.node("text", { spans = { ui.span(c.body) }, wrap = "word" }),
	})
end

local function block_node(state: State, b: number): Node
	local children: { Node } = { ui.node("md", { key = "md", text = model.display(state.m, b) }) }
	for _, ci in state.m.by_block[b] do
		table.insert(children, comment_node(state, ci))
	end
	return ui.node("col", {
		key = "b" .. b,
		role = "margin.block",
		tone = if b == state.sel then "accent" else nil,
		actions = { click = "sel=" .. b, dblclick = "compose=" .. b },
	}, children)
end

local function chip(key: string, label: string, act: string): Node
	return ui.node("text", {
		spans = { ui.span(key, "key"), ui.span(" " .. label, "muted") },
		role = "margin.chip",
		actions = { click = act },
	})
end

-- The block's first line without Markdown syntax, for "Comment on …".
local function first_line(s: string): string
	local line = string.match(s, "^[^\n]*") or ""
	line = string.gsub(line, "^[#>%-%+%*%s%d%.%)|]+", "")
	line = string.gsub(line, "[%*_`]", "")
	line = string.gsub(line, "%[([^%]]*)%]%([^%)]*%)", "%1")
	-- A table's header row reads as its cells: "Step · Owner · Command".
	line = string.gsub(line, "%s*|%s*", " · ")
	while string.sub(line, 1, 4) == " · " do
		line = string.sub(line, 5)
	end
	while string.sub(line, -4) == " · " do
		line = string.sub(line, 1, -5)
	end
	return line
end

local function dock(state: State): Node
	if state.mode == "compose" or state.mode == "edit" then
		local target = if #state.m.blocks > 0 then first_line(model.display(state.m, state.sel)) else ""
		return ui.col({
			ui.node("text", {
				spans = {
					ui.span(if state.mode == "edit" then "Edit comment on  " else "Comment on  ", "muted"),
					ui.span(target, "strong"),
				},
				truncate = "end",
			}),
			ui.node("editor", {
				key = "composer",
				text = state.ed.text,
				cursor = editor.utf16(state.ed.text, state.ed.cursor),
				placeholder = "Write a comment. Enter saves, Shift+Enter adds a line, Esc cancels.",
				maxLines = 6,
				aria = "Comment",
			}),
		})
	end
	if state.mode == "confirm" then
		return ui.col({
			ui.row({
				ui.node("text", { spans = { ui.span("Delete this comment?", "strong") } }),
				chip("y", "Delete", "confirm=yes"),
				chip("n", "Keep", "confirm=no"),
			}),
		})
	end
	local chips: { Node } = {
		chip("c", "Comment", "do=compose"),
	}
	if state.csel then
		table.insert(chips, chip("e", "Edit", "do=edit"))
		table.insert(chips, chip("x", "Delete", "do=delete"))
	end
	table.insert(chips, chip("tab", "Next comment", "do=next"))
	table.insert(chips, chip("D", "Done", "do=done"))
	table.insert(chips, chip("?", "Keys", "do=help"))
	local rows: { Node } = { ui.node("row", { gap = "md", wrap = true }, chips) }
	if state.help then
		table.insert(rows, ui.node("row", { gap = "md", wrap = true }, {
			chip("k j", "Down, up", "do=none"),
			chip("g G", "Top, bottom", "do=none"),
			chip("shift+tab", "Previous comment", "do=prev"),
			chip("t", "Open as text", "do=text"),
			chip("r", "Reload", "do=reload"),
			chip("q", "Close without finishing", "do=quit"),
		}))
	end
	return ui.col(rows)
end

local function view(state: State, _cx: BlockCx): BlockView
	local n = #state.m.comments
	local head = ui.node("row", { key = "head", role = "margin.head" }, {
		ui.node("text", { spans = { ui.span(basename(state.path), "strong") }, truncate = "middle" }),
		ui.node("row", { grow = 1 }),
		ui.node("text", {
			spans = { ui.span(if state.status then state.status .. "  ·  " else "", "muted"),
				ui.span(if n == 1 then "1 comment" else n .. " comments", if n > 0 then "accent" else "muted") },
		}),
	})
	local body: Node
	if state.error then
		body = ui.node("col", { key = "doc" }, {
			ui.node("card", { head = "Cannot open " .. basename(state.path), tone = "error" }, {
				ui.text({ ui.span(state.error, "muted") }),
			}),
		})
	elseif #state.m.blocks == 0 then
		body = ui.node("col", { key = "doc" }, { ui.text({ ui.span("This file is empty.", "muted") }) })
	else
		local nodes = table.create(#state.m.blocks) :: { Node }
		for b = 1, #state.m.blocks do
			nodes[b] = block_node(state, b)
		end
		body = ui.node("col", { key = "doc", gap = "xs", role = "margin.doc" }, nodes)
	end
	return { main = ui.col({ head, body }), dock = dock(state) }
end

-- Input ---------------------------------------------------------------------

local function do_action(state: State, cx: BlockCx, act: string)
	if act == "compose" and #state.m.blocks > 0 and state.error == nil then
		start_compose(state, cx, "compose", "")
	elseif act == "edit" and state.csel then
		start_compose(state, cx, "edit", state.m.comments[state.csel].body)
	elseif act == "delete" and state.csel then
		state.mode = "confirm"
	elseif act == "next" then
		cycle_comment(state, 1)
		reveal(state, cx)
	elseif act == "prev" then
		cycle_comment(state, -1)
		reveal(state, cx)
	elseif act == "done" then
		finish(state, cx, "done")
	elseif act == "quit" then
		finish(state, cx, "abandoned")
	elseif act == "help" then
		state.help = not state.help
	elseif act == "text" then
		cx:open(state.path)
	elseif act == "reload" then
		load(state)
		state.status = "Reloaded"
	end
end

local function browse_key(state: State, k: Key, cx: BlockCx): boolean
	local name, t = k.name, k.text
	if k.meta or k.ctrl then
		return false
	end
	-- k moves down and j moves up (the reverse of vim), by request.
	if name == "k" or name == "down" then
		select_block(state, state.sel + 1)
		reveal(state, cx, 1)
	elseif name == "j" or name == "up" then
		select_block(state, state.sel - 1)
		reveal(state, cx, -1)
	elseif t == "G" or name == "end" then
		select_block(state, #state.m.blocks)
		reveal(state, cx)
	elseif t == "g" or name == "home" then
		select_block(state, 1)
		reveal(state, cx)
	elseif name == "page_down" or name == "page_up" then
		cx:frame({ { "scroll", "main.doc", if name == "page_down" then "page-down" else "page-up" } })
		return false
	elseif name == "c" or name == "enter" then
		do_action(state, cx, "compose")
	elseif name == "tab" then
		do_action(state, cx, if k.shift then "prev" else "next")
	elseif name == "e" then
		do_action(state, cx, "edit")
	elseif name == "x" or name == "backspace" or name == "delete" then
		do_action(state, cx, "delete")
	elseif t == "D" then
		do_action(state, cx, "done")
	elseif name == "q" then
		do_action(state, cx, "quit")
	elseif name == "t" then
		do_action(state, cx, "text")
	elseif name == "r" then
		do_action(state, cx, "reload")
	elseif t == "?" then
		do_action(state, cx, "help")
	elseif name == "escape" then
		if state.csel == nil and not state.help then
			return false
		end
		state.csel = nil
		state.help = false
	else
		return false
	end
	return true
end

local function compose_key(state: State, k: Key, cx: BlockCx): boolean
	if k.name == "escape" then
		state.mode = "browse"
		if state.stale then
			state.stale = false
			load(state)
		end
		return true
	end
	if k.name == "enter" and not k.shift and not k.alt then
		submit(state, cx)
		if state.mode == "browse" and state.stale then
			state.stale = false
			load(state)
		end
		return true
	end
	return editor.key(state.ed, k)
end

local def: BlockDef<State> = {
	init = function(cx, args, saved)
		local path = args[1] or ""
		local s = if type(saved) == "table" then saved else {}
		local state: State = {
			path = path,
			started = if type(s.started) == "number" then s.started else os.time(),
			text = "",
			m = model.build(""),
			error = nil,
			sel = if type(s.sel) == "number" then s.sel else 1,
			csel = nil,
			mode = "browse",
			ed = editor.new(""),
			padded = {},
			stale = false,
			finished = false,
			help = false,
			status = nil,
		}
		if path == "" then
			state.error = "Open a Markdown file with `tern open FILE.md`, or Open with › Margin."
		else
			load(state)
		end
		-- A restart (plugin reload, daemon restart) keeps the selection and an
		-- unsent comment.
		local saved_csel = if type(s.csel) == "number" and state.m.comments[s.csel] then s.csel else nil
		if saved_csel and state.m.comments[saved_csel].block == state.sel then
			state.csel = saved_csel
		end
		if (s.mode == "compose" or s.mode == "edit") and type(s.draft) == "string" then
			state.mode = if s.mode == "edit" and state.csel then "edit" else "compose"
			state.ed = editor.new(s.draft)
			focus_composer(cx)
		end
		if path ~= "" then
			tern.timer(POLL_MS, function()
				poll(state, cx)
			end)
		end
		return state
	end,
	title = function(state)
		return "Review " .. basename(state.path)
	end,
	view = view,
	key = function(state, k, cx)
		if state.finished then
			return false
		end
		if state.mode == "compose" or state.mode == "edit" then
			return compose_key(state, k, cx)
		end
		if state.mode == "confirm" then
			if k.name == "y" or k.name == "enter" then
				delete_selected(state, cx)
			elseif k.name == "n" or k.name == "escape" then
				state.mode = "browse"
			else
				return false
			end
			return true
		end
		return browse_key(state, k, cx)
	end,
	event = function(state, ev, cx)
		if ev.ev ~= "action" or state.finished then
			return
		end
		local v = tonumber(ev.value)
		if ev.act == "sel" and v then
			if state.mode == "browse" then
				select_block(state, v)
			end
		elseif ev.act == "compose" and v then
			if state.mode == "browse" then
				select_block(state, v)
				do_action(state, cx, "compose")
			end
		elseif (ev.act == "com" or ev.act == "editcom") and v and state.m.comments[v] then
			if state.mode == "browse" then
				state.sel = state.m.comments[v].block
				state.csel = v
				if ev.act == "editcom" then
					do_action(state, cx, "edit")
				end
			end
		elseif ev.act == "confirm" then
			if ev.value == "yes" then
				delete_selected(state, cx)
			else
				state.mode = "browse"
			end
		elseif ev.act == "do" and ev.value and state.mode == "browse" then
			do_action(state, cx, ev.value)
		end
	end,
	save = function(state)
		return {
			started = state.started,
			sel = state.sel,
			csel = state.csel,
			mode = state.mode,
			draft = state.ed.text,
		}
	end,
}

tern.block.define("review", def)
