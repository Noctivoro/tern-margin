// Pure helpers behind bin/margin.mjs, kept separate so tests can import them.

const MARKERS = {
	comments: "{>>",
	insertions: "{++",
	deletions: "{--",
	substitutions: "{~~",
	highlights: "{==",
};

// Counts CriticMarkup openers outside fenced code and inline code spans.
export function countMarkup(text) {
	const markers = Object.entries(MARKERS);
	const counts = Object.fromEntries(markers.map(([kind]) => [kind, 0]));
	let fence = null;
	for (const line of text.split("\n")) {
		const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
		if (fence) {
			if (open && open[1][0] === fence[0] && open[1].length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
			continue;
		}
		if (open) {
			fence = open[1];
			continue;
		}
		// Drop inline code spans before counting.
		const prose = line.replace(/(`+)[\s\S]*?\1/g, "");
		for (const [kind, marker] of markers) {
			counts[kind] += prose.split(marker).length - 1;
		}
	}
	counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
	return counts;
}
