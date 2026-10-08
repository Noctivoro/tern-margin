--!strict
-- Optional palette command for Margin. The review itself is the `margin`
-- command (a Surface Protocol program), so it works in every Tern client;
-- this window half only adds "Review this Markdown file", which starts
-- `margin review` in a split beside the focused Markdown file block. The
-- `margin` command must be on PATH in the pane's shell.

local function is_markdown(path: string): boolean
	local lower = string.lower(path)
	return string.sub(lower, -3) == ".md" or string.sub(lower, -9) == ".markdown"
end

local function focused_markdown(cx: WindowCx): (number?, string?)
	local id = cx.session:focused()
	if id == nil then
		return nil, nil
	end
	local pane = cx.session:pane(id)
	if pane == nil or pane.kind ~= "file" or pane.path == nil or not is_markdown(pane.path) then
		return nil, nil
	end
	return id, pane.path
end

-- POSIX single-quoting for the launch command line.
local function quote(s: string): string
	return "'" .. string.gsub(s, "'", "'\\''") .. "'"
end

tern.command({
	id = "review_current",
	title = "Review this Markdown file",
	icon = "file",
	available = function(cx: WindowCx): boolean
		local id = focused_markdown(cx)
		return id ~= nil
	end,
	run = function(cx: WindowCx)
		local id, path = focused_markdown(cx)
		if id and path then
			cx.layout:split(id, "right", { command = "margin review " .. quote(path) })
		end
	end,
})
