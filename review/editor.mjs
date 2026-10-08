// The comment box's text. Tern draws the `editor` node; the program owns the
// text. With Tern's native editing on, edits arrive as `edit` events and go
// through `replace`/`undo`; otherwise every key arrives and `applyKey`
// applies it. `cursor` is a UTF-16 offset into `text` (0 = before the first
// character) that never splits a surrogate pair.
//
// Key shape as the Surface Protocol SDK delivers it:
//   { name, text?, ctrl, alt, shift, meta }

const MAX_UNDO = 200;

export function createEditor(text) {
	return { text, cursor: text.length, undo: [] };
}

function isHighSurrogate(c) {
	return c >= 0xd800 && c <= 0xdbff;
}

function isLowSurrogate(c) {
	return c >= 0xdc00 && c <= 0xdfff;
}

// Clamps a cursor to the text and off the middle of a surrogate pair.
function clampCursor(s, cursor) {
	let c = Math.max(0, Math.min(s.length, cursor));
	if (c > 0 && c < s.length && isHighSurrogate(s.charCodeAt(c - 1)) && isLowSurrogate(s.charCodeAt(c))) {
		c -= 1;
	}
	return c;
}

function prevChar(s, i) {
	if (i <= 0) return 0;
	if (i >= 2 && isLowSurrogate(s.charCodeAt(i - 1)) && isHighSurrogate(s.charCodeAt(i - 2))) return i - 2;
	return i - 1;
}

function nextChar(s, i) {
	if (i >= s.length) return s.length;
	if (i + 1 < s.length && isHighSurrogate(s.charCodeAt(i)) && isLowSurrogate(s.charCodeAt(i + 1))) return i + 2;
	return i + 1;
}

function isSpace(c) {
	return c === " " || c === "\t" || c === "\n";
}

function prevWord(s, i) {
	let j = i;
	while (j > 0 && isSpace(s[j - 1])) {
		j -= 1;
	}
	while (j > 0 && !isSpace(s[j - 1])) {
		j -= 1;
	}
	return j;
}

function nextWord(s, i) {
	let j = i;
	while (j < s.length && isSpace(s[j])) {
		j += 1;
	}
	while (j < s.length && !isSpace(s[j])) {
		j += 1;
	}
	return j;
}

function lineStart(s, i) {
	let j = i;
	while (j > 0 && s[j - 1] !== "\n") {
		j -= 1;
	}
	return j;
}

function lineEnd(s, i) {
	let j = i;
	while (j < s.length && s[j] !== "\n") {
		j += 1;
	}
	return j;
}

function snapshot(e) {
	e.undo.push({ text: e.text, cursor: e.cursor });
	if (e.undo.length > MAX_UNDO) {
		e.undo.shift();
	}
}

// Replaces UTF-16 [from, to) with `text` and moves the cursor to `cursor`
// (clamped to the text and never left inside a surrogate pair). The previous
// `{text, cursor}` goes on the undo stack, like every other edit.
export function replace(e, from, to, text, cursor) {
	const len = e.text.length;
	const a = Math.max(0, Math.min(len, from));
	const b = Math.max(a, Math.min(len, to));
	snapshot(e);
	e.text = e.text.slice(0, a) + text + e.text.slice(b);
	e.cursor = clampCursor(e.text, cursor);
}

// Pops the last snapshot. False when there is nothing to undo.
export function undo(e) {
	const last = e.undo.pop();
	if (last === undefined) return false;
	e.text = last.text;
	e.cursor = last.cursor;
	return true;
}

// Applies an edit and leaves the cursor just past the inserted text.
function editAt(e, from, to, insert) {
	replace(e, from, to, insert, from + insert.length);
}

// Applies one key. Returns false when the key changed nothing.
export function applyKey(e, k) {
	const name = k.name;
	const s = e.text;
	const c = e.cursor;
	const word = k.alt;
	const line = k.meta;
	if ((k.ctrl || k.meta) && name === "z") {
		return undo(e);
	}
	// Terminal kill keys: ⌃U to line start, ⌃K to line end, ⌃W a word back.
	// ⌘⌫ may be taken by the window's own bindings; these always arrive.
	if (k.ctrl && (name === "u" || name === "k" || name === "w")) {
		let from = c;
		let to = c;
		if (name === "u") {
			from = lineStart(s, c);
		} else if (name === "k") {
			to = lineEnd(s, c);
		} else {
			from = prevWord(s, c);
		}
		if (from === to) {
			return false;
		}
		editAt(e, from, to, "");
		return true;
	}
	if (name === "paste" && k.text) {
		editAt(e, c, c, k.text.replace(/\r\n?/g, "\n"));
		return true;
	}
	if (name === "enter") {
		editAt(e, c, c, "\n");
		return true;
	}
	if (name === "backspace") {
		if (c === 0) {
			return false;
		}
		let from = line ? lineStart(s, c) : word ? prevWord(s, c) : prevChar(s, c);
		if (from === c) {
			from = prevChar(s, c);
		}
		editAt(e, from, c, "");
		return true;
	}
	if (name === "delete") {
		if (c >= s.length) {
			return false;
		}
		const to = word ? nextWord(s, c) : nextChar(s, c);
		editAt(e, c, to, "");
		return true;
	}
	if (name === "left") {
		e.cursor = line ? lineStart(s, c) : word ? prevWord(s, c) : prevChar(s, c);
		return e.cursor !== c;
	}
	if (name === "right") {
		e.cursor = line ? lineEnd(s, c) : word ? nextWord(s, c) : nextChar(s, c);
		return e.cursor !== c;
	}
	if (name === "home" || (k.ctrl && name === "a")) {
		e.cursor = lineStart(s, c);
		return e.cursor !== c;
	}
	if (name === "end" || (k.ctrl && name === "e")) {
		e.cursor = lineEnd(s, c);
		return e.cursor !== c;
	}
	if (name === "up") {
		e.cursor = k.meta ? 0 : lineStart(s, c);
		return e.cursor !== c;
	}
	if (name === "down") {
		e.cursor = k.meta ? s.length : lineEnd(s, c);
		return e.cursor !== c;
	}
	if (k.text && k.text !== "" && !k.ctrl && !k.meta) {
		editAt(e, c, c, k.text);
		return true;
	}
	return false;
}
