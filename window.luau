--!strict
-- The window half: `tern open FILE.md` (how agents ask for a review) opens
-- the Margin review block. Opens from the Files pane, the palette, links and
-- drops keep the native file block; "Review this Markdown file" and the file
-- block's Open with menu reach the review block from there.

local ROUTE_KEY = "route_cli"

local function enabled(): boolean
	return tern.kv.get(ROUTE_KEY) ~= false
end

local function is_markdown(path: string): boolean
	local lower = string.lower(path)
	return string.sub(lower, -3) == ".md" or string.sub(lower, -9) == ".markdown"
end

-- Temp files that `$EDITOR`-style tools hand to `tern open --wait` (a PR
-- body from `gh`, a commit message) must stay plain text edits. Besides the
-- usual temp folders, honor this window's TMPDIR, TEMP and TMP.
local SCRATCH = { "/var/folders/", "/private/var/folders/", "/tmp/", "/private/tmp/" }
for _, name in { "TMPDIR", "TEMP", "TMP" } do
	local dir = tern.getenv(name)
	if dir and dir ~= "" then
		local sep = if string.find(dir, "\\", 1, true) then "\\" else "/"
		table.insert(SCRATCH, if string.sub(dir, -1) == sep then dir else dir .. sep)
	end
end

local function scratch(path: string): boolean
	for _, prefix in SCRATCH do
		if string.sub(path, 1, #prefix) == prefix then
			return true
		end
	end
	return string.find(path, "/.git/", 1, true) ~= nil or string.find(path, "\\.git\\", 1, true) ~= nil
end

tern.route.open(function(req: OpenRequest, _cx: WindowCx): RouteDecision?
	if req.origin ~= "cli" or req.how == "replace" or req.how == "preview" then
		return nil
	end
	if not enabled() or not is_markdown(req.path) or scratch(req.path) then
		return nil
	end
	return { block = "margin.review", args = { req.path } }
end)

tern.command({
	id = "toggle_route",
	title = "Toggle Margin for `tern open`",
	icon = "file",
	run = function(cx: WindowCx)
		local on = not enabled()
		tern.kv.set(ROUTE_KEY, on)
		if on then
			cx:toast("success", "`tern open FILE.md` opens Margin")
		else
			cx:toast("info", "`tern open FILE.md` opens the text editor", "Open with › Margin still works")
		end
	end,
})

local function focused_markdown(cx: WindowCx): string?
	local id = cx.session:focused()
	if id == nil then
		return nil
	end
	local pane = cx.session:pane(id)
	if pane == nil or pane.kind ~= "file" or pane.path == nil or not is_markdown(pane.path) then
		return nil
	end
	return pane.path
end

tern.command({
	id = "review_current",
	title = "Review this Markdown file",
	icon = "file",
	available = function(cx: WindowCx): boolean
		return focused_markdown(cx) ~= nil
	end,
	run = function(cx: WindowCx)
		local path = focused_markdown(cx)
		if path then
			cx:new_block("margin.review", { path }, "beside")
		end
	end,
})
