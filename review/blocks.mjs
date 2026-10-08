// Splits Markdown source into top-level blocks with one-based, inclusive
// source line ranges. Pure: no `tern` calls, so `node --test` can test it.
//
// Invariants:
//   * blocks are in source order and never overlap;
//   * every non-blank line belongs to exactly one block;
//   * a paragraph made only of CriticMarkup comments attaches to the block
//     before it (that block's `last` grows; `contentLast` does not), so
//     adding a standalone comment never changes the block count.
//
// A block is `{kind, first, contentLast, last, level?, anchor}`:
//   * `first` … `last` is the block's full 1-based, inclusive line range;
//   * `contentLast` is the last line of the block's own content (before any
//     attached comment-only paragraphs);
//   * `level` is set only for `kind === "heading"`;
//   * `anchor` is the line holding the text an inline comment attaches to.
//
// Indexing: `parse` returns a 1-based list (index 0 is unused, so the count
// is `list.length - 1`); line numbers are 1-based and inclusive.
import { stripComments } from "./critic.mjs";

// Splits on "\n" exactly; a trailing newline gives a final empty line.
export function lines(text) {
	return text.split("\n");
}

function blank(line) {
	return /^\s*$/.test(line);
}

function indent(line) {
	let spaces = 0;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === " ") {
			spaces += 1;
		} else if (c === "\t") {
			spaces += 4 - (spaces % 4);
		} else {
			break;
		}
	}
	return spaces;
}

function stripCr(line) {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function fenceOpen(line) {
	if (indent(line) > 3) return [null, 0];
	const run = /^\s*(`{3,})/.exec(line)?.[1] ?? /^\s*(~{3,})/.exec(line)?.[1];
	if (run === undefined) return [null, 0];
	// A backtick fence's info string cannot contain backticks.
	const lead = /^\s*/.exec(line)[0];
	if (run[0] === "`" && line.slice(lead.length + run.length).includes("`")) return [null, 0];
	return [run[0], run.length];
}

function fenceClose(line, ch, len) {
	if (indent(line) > 3) return false;
	const run = (ch === "`" ? /^\s*(`{3,})\s*$/ : /^\s*(~{3,})\s*$/).exec(line)?.[1];
	return run !== undefined && run.length >= len;
}

function atx(line) {
	if (indent(line) > 3) return null;
	const hashes = /^\s*(#+)\s/.exec(line)?.[1] ?? /^\s*(#+)$/.exec(line)?.[1];
	if (hashes !== undefined && hashes.length <= 6) return hashes.length;
	return null;
}

function thematic(line) {
	if (indent(line) > 3) return false;
	const s = line.replace(/\s/g, "");
	if (s.length < 3) return false;
	const c = s[0];
	if (c !== "-" && c !== "*" && c !== "_") return false;
	for (let i = 1; i < s.length; i++) {
		if (s[i] !== c) return false;
	}
	return true;
}

function setext(line) {
	if (indent(line) > 3) return null;
	if (/^\s*=+\s*$/.test(line)) return 1;
	if (/^\s*-+\s*$/.test(line)) return 2;
	return null;
}

// A list marker: returns the marker's indent and the content column.
function listMarker(line) {
	const lead = /^ */.exec(line)[0];
	if (lead.length > 3) return [null, 0];
	const rest = line.slice(lead.length);
	let marker = /^([-+*])\s/.exec(rest)?.[1] ?? /^([-+*])$/.exec(rest)?.[1];
	if (marker === undefined) {
		marker = /^(\d{1,9}[.)])\s/.exec(rest)?.[1] ?? /^(\d{1,9}[.)])$/.exec(rest)?.[1];
	}
	if (marker === undefined) return [null, 0];
	const after = rest.slice(marker.length);
	let gap = /^ */.exec(after)[0].length;
	if (gap === 0 || gap > 4 || blank(after)) gap = 1;
	return [lead.length, lead.length + marker.length + gap];
}

function quoteLine(line) {
	return indent(line) <= 3 && /^\s*>/.test(line);
}

function htmlLine(line) {
	return indent(line) <= 3 && /^\s*<[a-zA-Z!?/]/.test(line);
}

// CommonMark HTML block types 1-6, the only ones that interrupt a paragraph.
// An inline tag such as `<span>` at the start of a line (type 7) does not.
const HTML_BLOCK_TAGS = new Set(
	("address article aside base basefont blockquote body caption center col colgroup dd " +
		"details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 " +
		"head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param " +
		"search section summary table tbody td tfoot th thead title tr track ul pre script style textarea").split(/\s+/),
);

function htmlInterrupts(line) {
	if (!htmlLine(line)) return false;
	const rest = /^\s*<(.*)$/.exec(line)[1];
	if (/^[!?]/.test(rest)) return true; // comments, processing instructions, declarations, CDATA
	const tag = /^\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(rest)?.[1];
	return tag !== undefined && HTML_BLOCK_TAGS.has(tag.toLowerCase());
}

function tableDelim(line) {
	let s = line.replace(/\s/g, "");
	if (!s.includes("-")) return false;
	const hadPipe = s.includes("|");
	s = s.replace(/^\|/, "").replace(/\|$/, "");
	if (s === "") return false;
	let cells = 0;
	for (const m of (s + "|").matchAll(/([^|]*)\|/g)) {
		if (!/^:?-+:?$/.test(m[1])) return false;
		cells += 1;
	}
	// One column without pipes would be a setext underline or a rule.
	return hadPipe || cells > 1;
}

// Whether `line` starts a block that interrupts a paragraph.
function interrupts(line) {
	if (atx(line) !== null || thematic(line) || quoteLine(line) || htmlInterrupts(line)) return true;
	if (fenceOpen(line)[0] !== null) return true;
	const mi = listMarker(line);
	if (mi[0] !== null) {
		// Only bullets and lists starting at 1 interrupt a paragraph, and
		// never with an empty item.
		const rest = line.slice(mi[0]);
		const num = /^(\d+)[.)]/.exec(rest)?.[1];
		const body = /^\S+\s+(.*)$/.exec(rest)?.[1];
		return (num === undefined || num === "1") && body !== undefined && !blank(body);
	}
	return false;
}

function commentOnly(rows, first, last) {
	const parts = [];
	for (let i = first; i <= last; i++) {
		parts.push(rows[i - 1]);
	}
	const text = parts.join("\n");
	if (!text.includes("{>>")) return false;
	return blank(stripComments(text));
}

export function parse(text) {
	const raw = lines(text);
	const rows = raw.map(stripCr);
	const n = rows.length;
	const out = [undefined]; // 1-based: index 0 stays unused
	let i = 1;

	const push = (kind, first, last, anchor, level) => {
		const blk = { kind, first, contentLast: last, last, anchor };
		if (level !== undefined) blk.level = level;
		out.push(blk);
	};

	// Front matter: "---" on line 1 closed by "---" or "...".
	if (n > 1 && rows[0] === "---") {
		for (let j = 2; j <= n; j++) {
			if (rows[j - 1] === "---" || rows[j - 1] === "...") {
				push("frontmatter", 1, j, j);
				i = j + 1;
				break;
			}
		}
	}

	while (i <= n) {
		const line = rows[i - 1];
		if (blank(line)) {
			i += 1;
			continue;
		}

		const [ch, len] = fenceOpen(line);
		if (ch !== null) {
			let j = i + 1;
			while (j <= n && !fenceClose(rows[j - 1], ch, len)) {
				j += 1;
			}
			const last = Math.min(j, n);
			push("code", i, last, last);
			i = last + 1;
			continue;
		}

		const level = atx(line);
		if (level !== null) {
			push("heading", i, i, i, level);
			i += 1;
			continue;
		}

		if (thematic(line)) {
			push("rule", i, i, i);
			i += 1;
			continue;
		}

		if (htmlLine(line)) {
			let j = i;
			while (j + 1 <= n && !blank(rows[j])) {
				j += 1;
			}
			push("html", i, j, j);
			i = j + 1;
			continue;
		}

		if (quoteLine(line)) {
			let j = i;
			// Lazy continuation only carries paragraph text: a heading, list,
			// fence, rule or HTML block after the quote starts a new block.
			while (j + 1 <= n && !blank(rows[j]) && (quoteLine(rows[j]) || !interrupts(rows[j]))) {
				j += 1;
			}
			push("quote", i, j, j);
			i = j + 1;
			continue;
		}

		const [mi, contentCol] = listMarker(line);
		if (mi !== null) {
			// The item runs until a blank line followed by a line indented
			// less than its content, or a sibling marker at its indent.
			let j = i;
			let paraEnd = i; // last line of the item's first paragraph
			let inFirstPara = true;
			while (j + 1 <= n) {
				const nxt = rows[j];
				if (blank(nxt)) {
					let k = j + 1;
					while (k <= n && blank(rows[k - 1])) {
						k += 1;
					}
					if (k > n || indent(rows[k - 1]) < contentCol) {
						break;
					}
					inFirstPara = false;
					j = k;
					continue;
				}
				const nmi = listMarker(nxt);
				if (nmi[0] !== null && nmi[0] <= mi) {
					break;
				}
				if (indent(nxt) < contentCol) {
					// Lazy continuation only for paragraph text.
					if (nmi[0] !== null || interrupts(nxt) || !inFirstPara) {
						break;
					}
				}
				if (inFirstPara && (nmi[0] !== null || fenceOpen(nxt)[0] !== null)) {
					inFirstPara = false;
				}
				j += 1;
				if (inFirstPara) {
					paraEnd = j;
				}
			}
			push("list_item", i, j, paraEnd);
			i = j + 1;
			continue;
		}

		// Table: a header row followed by a delimiter row.
		if (line.includes("|") && i + 1 <= n && tableDelim(rows[i])) {
			let j = i + 1;
			while (j + 1 <= n && !blank(rows[j]) && rows[j].includes("|")) {
				j += 1;
			}
			push("table", i, j, j);
			i = j + 1;
			continue;
		}

		// Paragraph, possibly a setext heading.
		let j = i;
		let headingLevel = null;
		while (j + 1 <= n) {
			const nxt = rows[j];
			if (blank(nxt)) {
				break;
			}
			const sl = setext(nxt);
			if (sl !== null) {
				headingLevel = sl;
				j += 1;
				break;
			}
			if (interrupts(nxt)) {
				break;
			}
			j += 1;
		}
		if (headingLevel !== null) {
			push("heading", i, j, j - 1, headingLevel);
		} else if (out.length > 1 && commentOnly(rows, i, j)) {
			out[out.length - 1].last = j;
		} else {
			push("paragraph", i, j, j);
		}
		i = j + 1;
	}
	return out;
}
