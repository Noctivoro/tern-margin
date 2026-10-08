// Pure helpers behind bin/margin.mjs, kept separate so tests can import them.
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Where the plugin writes receipts: `<state>/plugin-data/margin/receipts`.
export function receiptsDir(env = process.env, platform = process.platform) {
	let state;
	if (env.TERN_CONFIG_DIR) state = env.TERN_CONFIG_DIR;
	else if (platform === "darwin") state = join(homedir(), "Library", "Application Support", "Tern");
	else if (platform === "win32") state = join(env.LOCALAPPDATA ?? homedir(), "Tern");
	else state = join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "tern");
	return join(state, "plugin-data", "margin", "receipts");
}

// The newest receipt for `path` finished at or after `since` (epoch seconds).
export function findReceipt(dir, path, since) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return null;
	}
	let best = null;
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let r;
		try {
			r = JSON.parse(readFileSync(join(dir, name), "utf8"));
		} catch {
			continue;
		}
		if (r.path !== path || typeof r.finished_at !== "number" || r.finished_at < since) continue;
		if (best === null || r.finished_at > best.finished_at) best = r;
	}
	return best;
}

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
