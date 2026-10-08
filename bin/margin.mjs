#!/usr/bin/env node
// margin: review Markdown files in Tern and leave CriticMarkup comments.
//
//   margin review FILE           review FILE in this pane
//   margin open FILE [--json]    review FILE in a new pane beside this one and
//                                wait for the result (for agents and scripts)
//   margin doctor FILE [--json]  count CriticMarkup left in FILE (exit 1 if any)
//
// The review screen is a Tern Surface Protocol program, so it draws natively
// in every Tern client attached to the pane: desktop, iOS and web.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countMarkup } from '../cli/core.mjs';

const USAGE = 'usage: margin review FILE\n       margin open FILE [--json]\n       margin doctor FILE [--json]';
const EXIT_DONE = 0;
const EXIT_ABANDONED = 3;
const EXIT_LOST = 4;
const EXIT_NO_SURFACE = 5;

function fail(message, code = 2) {
	process.stderr.write(`margin: ${message}\n`);
	process.exit(code);
}

function resolveFile(file) {
	try {
		return realpathSync(resolve(file));
	} catch {
		fail(`no such file: ${file}`);
	}
}

async function review(file) {
	const path = resolveFile(file);
	const { runReview } = await import('../review/app.mjs');
	const code = await runReview(path);
	if (code === EXIT_NO_SURFACE) fail('this terminal does not speak the Tern Surface Protocol; run margin inside Tern', EXIT_NO_SURFACE);
	process.exit(code);
}

// Runs `fn`; any thrown error becomes a clean `margin: …` message.
function attempt(what, fn) {
	try {
		return fn();
	} catch (err) {
		fail(`${what}: ${err.message}`);
	}
}

function open(file, json) {
	if (!process.env.TERN_PANE) fail('run this inside a Tern pane (TERN_PANE is not set)');
	const path = resolveFile(file);
	const workDir = join(tmpdir(), 'margin');
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const name = basename(path).replace(/\.(md|markdown)$/i, '');
	const prePath = join(workDir, `${name}.${stamp}.pre-review.md`);
	attempt('could not save a pre-review copy', () => {
		mkdirSync(workDir, { recursive: true });
		copyFileSync(path, prePath);
	});

	// The review runs as an ordinary command in a split: the daemon starts it,
	// so it works whichever client (desktop, phone, web) has focus.
	const self = fileURLToPath(import.meta.url);
	const split = spawnSync('tern', ['split', process.env.TERN_PANE, 'right', '--json', '--', process.execPath, self, 'review', path], { encoding: 'utf8' });
	if (split.error) fail(`could not run tern: ${split.error.message}`);
	if (split.status !== 0) fail(`tern split failed: ${split.stderr.trim()}`);
	const block = attempt('tern split printed something unexpected', () => String(JSON.parse(split.stdout).block ?? ''));
	if (!block) fail('tern split did not report the new pane');

	// `tern wait` exits with the program's status: 0 done, 3 closed early,
	// 4 screen lost; anything else (pane closed, crash) did not finish. A pane
	// whose program exits 0 closes by itself; after 3 or 4 it would stay open
	// with nothing to show, so close it.
	const waited = spawnSync('tern', ['wait', block, '--until', 'exit'], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
	const status = waited.status === EXIT_DONE ? 'done' : waited.status === EXIT_ABANDONED ? 'abandoned' : 'closed';
	if (waited.status === EXIT_ABANDONED || waited.status === EXIT_LOST) spawnSync('tern', ['close', block], { stdio: 'ignore' });

	const before = attempt('could not read the pre-review copy', () => readFileSync(prePath, 'utf8'));
	const after = attempt(`could not read ${path}`, () => readFileSync(path, 'utf8'));
	const diffPath = join(workDir, `${name}.${stamp}.diff`);
	attempt('could not write the diff', () => writeFileSync(diffPath, spawnSync('diff', ['-u', prePath, path], { encoding: 'utf8' }).stdout ?? ''));
	const result = {
		status,
		path,
		comments: countMarkup(after).comments,
		comments_before: countMarkup(before).comments,
		changed: before !== after,
		pre_review_path: prePath,
		diff_path: diffPath,
	};
	if (json) {
		process.stdout.write(JSON.stringify(result, null, 2) + '\n');
	} else {
		const verb = {
			done: 'Review finished',
			abandoned: 'Review closed before finishing',
			closed: 'Review pane closed without finishing',
		}[status];
		process.stdout.write(`${verb}: ${path}\n${result.comments} comments (${result.comments_before} before). Diff: ${diffPath}\n`);
	}
	process.exit(status === 'done' ? 0 : 3);
}

function doctor(file, json) {
	let text;
	try {
		text = readFileSync(resolve(file), 'utf8');
	} catch {
		fail(`no such file: ${file}`);
	}
	const counts = countMarkup(text);
	if (json) process.stdout.write(JSON.stringify({ path: resolve(file), ...counts, clean: counts.total === 0 }, null, 2) + '\n');
	else process.stdout.write(counts.total === 0 ? 'clean: no CriticMarkup outside code\n' : `${counts.total} CriticMarkup markers: ${JSON.stringify(counts)}\n`);
	process.exit(counts.total === 0 ? 0 : 1);
}

const [cmd, file, ...rest] = process.argv.slice(2);
const json = rest.includes('--json');
if (!file || !['review', 'open', 'doctor'].includes(cmd)) fail(USAGE);
if (cmd === 'review') await review(file);
else if (cmd === 'open') open(file, json);
else doctor(file, json);
