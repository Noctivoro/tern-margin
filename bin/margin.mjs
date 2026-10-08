#!/usr/bin/env node
// margin: the command-line entry point for Margin, the Tern review plugin.
//
//   margin open FILE [--json]    open FILE in the review block and wait until
//                                the reviewer finishes or closes it
//   margin doctor FILE [--json]  count CriticMarkup left in FILE (exit 1 if any)
//
// A block can restart without the reviewer finishing (a plugin reload does
// it), so `open` trusts only the receipt the block writes on Done (D) or
// Close (q), and waits again while the block is still running.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { countMarkup, findReceipt, receiptsDir } from "../cli/core.mjs";

const BLOCK_KIND = "margin.review";
const USAGE = "usage: margin open FILE [--json]\n       margin doctor FILE [--json]";

function fail(message, code = 2) {
	process.stderr.write(`margin: ${message}\n`);
	process.exit(code);
}

function tern(args) {
	return spawnSync("tern", args, { encoding: "utf8" });
}

function allBlocks() {
	const r = tern(["ls", "--json"]);
	if (r.status !== 0) return [];
	const out = [];
	for (const session of JSON.parse(r.stdout).sessions ?? []) {
		for (const tab of session.tabs ?? []) out.push(...(tab.blocks ?? []));
	}
	return out;
}

function open(file, json) {
	if (!process.env.TERN_PANE) fail("run this inside a Tern pane (TERN_PANE is not set)");
	let path;
	try {
		path = realpathSync(resolve(file));
	} catch {
		fail(`no such file: ${file}`);
	}
	const workDir = join(tmpdir(), "margin");
	mkdirSync(workDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = basename(path).replace(/\.(md|markdown)$/i, "");
	const prePath = join(workDir, `${name}.${stamp}.pre-review.md`);
	copyFileSync(path, prePath);
	const since = Math.floor(Date.now() / 1000);

	const opened = tern(["open", "--json", path]);
	if (opened.status !== 0) fail(`tern open failed: ${opened.stderr.trim()}`);
	const id = String(JSON.parse(opened.stdout).blocks?.[0] ?? "");
	const block = allBlocks().find((b) => String(b.id) === id);
	if (!block || block.program !== BLOCK_KIND) {
		// The window that took the open has no Margin window half (a phone or
		// web client that has focus), or the route is toggled off.
		fail(
			"the file opened in a plain file block, not Margin. Open it from a desktop Tern window with the plugin " +
				"installed, check `Toggle Margin for tern open`, or use Open with › Margin.",
			4,
		);
	}

	const dir = receiptsDir();
	let receipt = null;
	// `tern wait` can end early when a plugin reload restarts the block; wait
	// again while it still runs, a bounded number of times.
	for (let round = 0; round < 20; round++) {
		tern(["wait", id, "--until", "exit"]);
		receipt = findReceipt(dir, path, since);
		if (receipt !== null) break;
		const still = allBlocks().some((b) => String(b.id) === id && b.program === BLOCK_KIND && b.exited == null);
		if (!still) break;
	}

	const before = readFileSync(prePath, "utf8");
	const after = readFileSync(path, "utf8");
	const diffPath = join(workDir, `${name}.${stamp}.diff`);
	writeFileSync(diffPath, spawnSync("diff", ["-u", prePath, path], { encoding: "utf8" }).stdout);
	const result = {
		status: receipt?.status ?? "closed",
		path,
		comments: countMarkup(after).comments,
		comments_before: countMarkup(before).comments,
		changed: before !== after,
		pre_review_path: prePath,
		diff_path: diffPath,
	};
	if (json) {
		process.stdout.write(JSON.stringify(result, null, 2) + "\n");
	} else {
		const verb = {
			done: "Review finished",
			abandoned: "Review closed before finishing",
			closed: "Review pane closed without a receipt",
		}[result.status];
		process.stdout.write(`${verb}: ${path}\n${result.comments} comments (${result.comments_before} before). Diff: ${diffPath}\n`);
	}
	process.exit(result.status === "done" ? 0 : 3);
}

function doctor(file, json) {
	let text;
	try {
		text = readFileSync(resolve(file), "utf8");
	} catch {
		fail(`no such file: ${file}`);
	}
	const counts = countMarkup(text);
	if (json) process.stdout.write(JSON.stringify({ path: resolve(file), ...counts, clean: counts.total === 0 }, null, 2) + "\n");
	else process.stdout.write(counts.total === 0 ? "clean: no CriticMarkup outside code\n" : `${counts.total} CriticMarkup markers: ${JSON.stringify(counts)}\n`);
	process.exit(counts.total === 0 ? 0 : 1);
}

const [cmd, file, ...rest] = process.argv.slice(2);
const json = rest.includes("--json");
if (!file || (cmd !== "open" && cmd !== "doctor")) fail(USAGE);
if (cmd === "open") open(file, json);
else doctor(file, json);
