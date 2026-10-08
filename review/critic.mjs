// CriticMarkup comment helpers. Pure: no `tern` calls.
//
// Offsets: every offset in `review/` is a 0-based UTF-16 code-unit index into
// the JS string, and a span's `e` is inclusive — the index of the final "}"
// of "<<}". `find` returns a plain, 0-based array.

// Every `{>>…<<}` span in `text`, in order. A comment never spans a blank
// line (`sanitize` guarantees it for comments Margin writes), so an opener
// with no closer before the next blank line is left as text. Without that
// bound, a stray `{>>` would pair with a later comment's `<<}` and deleting
// the "comment" would erase everything between them.
export function find(text) {
	const out = [];
	const paraBreak = /\n[ \t\r]*\n/g;
	let pos = 0;
	for (;;) {
		const s = text.indexOf("{>>", pos);
		if (s === -1) break;
		const close = text.indexOf("<<}", s + 3);
		paraBreak.lastIndex = s + 3;
		const brk = paraBreak.exec(text);
		const paraEnd = brk === null ? -1 : brk.index;
		if (close === -1 || (paraEnd !== -1 && paraEnd < close)) {
			pos = s + 3;
			continue;
		}
		out.push({ s, e: close + 2, body: text.slice(s + 3, close) });
		pos = close + 3;
	}
	return out;
}

// `text` with every comment span removed.
export function stripComments(text) {
	const out = [];
	let pos = 0;
	for (const sp of find(text)) {
		out.push(text.slice(pos, sp.s));
		pos = sp.e + 1;
	}
	out.push(text.slice(pos));
	return out.join("");
}

// Removes highlight markers, keeping the highlighted text: `{==x==}` -> `x`.
export function unwrapHighlights(text) {
	return text.replace(/\{==([\s\S]*?)==\}/g, "$1");
}

// Makes reviewer text safe to store inside `{>>…<<}`: no closing or opening
// delimiter, no carriage returns, no blank lines (a blank line would end the
// paragraph the comment sits in), no surrounding whitespace.
export function sanitize(body) {
	let s = body.replace(/\r/g, "");
	s = s.replace(/<<}/g, "<< }");
	s = s.replace(/\{>>/g, "{ >>");
	s = s.replace(/\n[ \t]*\n\s*/g, "\n");
	return s.trim();
}

export function wrap(body) {
	return "{>>" + body + "<<}";
}
