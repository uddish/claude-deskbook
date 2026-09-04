#!/usr/bin/env node
// deskbook — index, create and clean up work notes. No dependencies.
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Notes live per project, keyed by the working directory, matching the layout Claude
 * Code already uses for a project's own files. `DESKBOOK_HOME` overrides it.
 */
function resolveRoot() {
	if (process.env.DESKBOOK_HOME) return process.env.DESKBOOK_HOME;
	const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
	const slug = process.cwd().replace(/[/\\]/g, '-');
	return join(config, 'projects', slug, 'notes');
}
const ROOT = resolveRoot();

/** The repository whose worktrees cleanup may prune. Defaults to the working directory. */
function resolveRepo() {
	if (process.env.DESKBOOK_REPO) return process.env.DESKBOOK_REPO;
	try {
		return execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
	} catch {
		return null;
	}
}
const STATUSES = ['active', 'blocked', 'parked', 'done'];
const DONE_AFTER_DAYS = 14;
const RUN_AFTER_DAYS = 7;
const PR_TTL_MS = 10 * 60 * 1000;
const DAY = 86_400_000;

/** Minimal YAML front matter: scalars, `[a, b]` inline lists, and `- item` block lists. */
function parseFrontMatter(text) {
	if (!text.startsWith('---\n')) return {};
	const end = text.indexOf('\n---', 3);
	if (end === -1) return {};
	const out = {};
	let key = null;
	for (const raw of text.slice(4, end).split('\n')) {
		const line = raw.trimEnd();
		if (!line || line.startsWith('#')) continue;
		const item = line.match(/^\s+-\s+(.*)$/);
		if (item && key) {
			(out[key] ||= []).push(stripQuotes(item[1]));
			continue;
		}
		const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
		if (!kv) continue;
		key = kv[1];
		const value = kv[2].trim();
		if (value === '') out[key] = [];
		else if (value.startsWith('[')) out[key] = value.slice(1, -1).split(',').map((s) => stripQuotes(s.trim())).filter(Boolean);
		else out[key] = stripQuotes(value);
	}
	return out;
}
const stripQuotes = (s) => s.replace(/^["']|["']$/g, '');

/** Any tracker works: the label comes from the host, never a hardcoded vendor. */
const HOSTS = {
	'linear.app': 'Linear', 'github.com': 'GitHub', 'gitlab.com': 'GitLab',
	'bitbucket.org': 'Bitbucket', 'notion.so': 'Notion', 'trello.com': 'Trello',
	'asana.com': 'Asana', 'app.shortcut.com': 'Shortcut', 'basecamp.com': 'Basecamp',
	'height.app': 'Height', 'monday.com': 'Monday', 'clickup.com': 'ClickUp',
	'app.plane.so': 'Plane', 'youtrack.cloud': 'YouTrack',
};
function labelLink(raw) {
	const pair = raw.match(/^([^:]{1,40}):\s*(https?:\/\/.*)$/);
	if (pair) return { label: pair[1].trim(), url: pair[2].trim() };
	let host = '';
	try { host = new URL(raw).hostname.replace(/^www\./, ''); } catch { return { label: raw, url: raw }; }
	const known = Object.keys(HOSTS).find((h) => host === h || host.endsWith('.' + h));
	if (known) return { label: HOSTS[known], url: raw };
	if (/(^|\.)atlassian\.net$/.test(host)) return { label: 'Jira', url: raw };
	if (/jira/.test(host)) return { label: 'Jira', url: raw };
	return { label: host, url: raw };
}
const body = (text) => {
	if (!text.startsWith('---\n')) return text;
	const end = text.indexOf('\n---', 3);
	return end === -1 ? text : text.slice(end + 4).replace(/^\n+/, '');
};

const walk = (dir, out = []) => {
	for (const name of readdirSync(dir)) {
		if (name.startsWith('.')) continue;
		const p = join(dir, name);
		statSync(p).isDirectory() ? walk(p, out) : out.push(p);
	}
	return out;
};
const heading = (text) => (body(text).match(/^#\s+(.+)$/m) || [])[1];
const rankFile = (name) => (name === 'README.md' ? 0 : name === 'plan.md' ? 1 : name.endsWith('.md') ? 2 : 3);
const titleCase = (slug) => {
	const m = slug.match(/^([a-z]+)-(\d+)-?(.*)$/);
	const rest = (t) => t.replace(/[-_]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
	if (m) return `${m[1].toUpperCase()}-${m[2]}${m[3] ? ' ' + rest(m[3]) : ''}`;
	return rest(slug);
};

/** One entry per work item: a bare .md file, or a directory keyed by its README. */
function collect(area) {
	const dir = join(ROOT, area);
	let names;
	try { names = readdirSync(dir); } catch { return []; }
	const items = [];
	for (const name of names.sort()) {
		if (name.startsWith('.')) continue;
		const path = join(dir, name);
		const isDir = statSync(path).isDirectory();
		const entry = isDir ? join(path, 'README.md') : path;
		if (!isDir && !name.endsWith('.md')) continue;

		let text = '';
		try { text = readFileSync(entry, 'utf8'); } catch { /* directory without a README */ }
		const fm = parseFrontMatter(text);
		const files = (isDir ? walk(path) : [path]).map((f) => ({
			path: relative(ROOT, f),
			name: relative(path, f) || basename(f),
			md: f.endsWith('.md') ? body(readFileSync(f, 'utf8')) : null,
			bytes: statSync(f).size,
		}));
		const mtime = Math.max(...files.map((f) => statSync(join(ROOT, f.path)).mtimeMs));

		// plan.md is the canonical document, so its H1 beats an alphabetically-earlier file.
		const ranked = [...files].sort((a, b) => rankFile(a.name) - rankFile(b.name));
		const firstHeading = ranked.map((f) => f.md && heading(`---\n---\n${f.md}`)).find(Boolean);
		items.push({
			area,
			isDir,
			slug: name.replace(/\.md$/, ''),
			title: fm.title || heading(text) || firstHeading || titleCase(name.replace(/\.md$/, '')),
			status:
				area === 'archive' ? 'done'
				: area === 'reference' ? 'reference'
				: STATUSES.includes(fm.status) ? fm.status
				: 'active',
			id: fm.id || null,
			tags: fm.tags || [],
			branches: fm.branches || [],
			links: (fm.links || []).map(labelLink),
			intro: isDir ? body(text) : null,
			files,
			updated: new Date(mtime).toISOString().slice(0, 10),
			mtime,
		});
	}
	return items;
}

/** Every worktree of the repo, with PR state when `gh` is available. */
function worktrees() {
	const repo = resolveRepo();
	if (!repo) return [];
	const git = (c) => execSync(`git -C ${JSON.stringify(repo)} ${c}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	let listing;
	try { listing = git('worktree list --porcelain'); } catch { return []; }

	const out = [];
	let path = null;
	let head = null;
	let first = true;
	for (const line of listing.split('\n')) {
		if (line.startsWith('worktree ')) { path = line.slice(9); head = null; }
		else if (line.startsWith('HEAD ')) head = line.slice(5, 12);
		else if (line === 'detached' && path) { out.push({ path, branch: null, head, pr: null, main: first, agent: path.includes('/.claude/worktrees/') }); path = null; first = false; }
		else if (line.startsWith('branch ') && path) {
			out.push({ path, branch: line.slice(7).replace('refs/heads/', ''), head, pr: null, main: first, agent: path.includes('/.claude/worktrees/') });
			path = null;
			first = false;
		}
	}
	// `gh pr view` costs about a second each, which is too slow for a page load or a
	// session hook, so results are cached on disk for PR_TTL_MS.
	const cachePath = join(ROOT, 'run', '.cache', 'pr.json');
	let cache = {};
	try { cache = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* first run */ }
	let dirty = false;
	for (const w of out) {
		if (!w.branch) continue;
		const hit = cache[w.branch];
		if (hit && Date.now() - hit.at < PR_TTL_MS) { w.pr = hit.pr; continue; }
		let pr = null;
		try {
			const json = execSync(`gh pr view ${JSON.stringify(w.branch)} --json number,state`, {
				encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repo,
			});
			const { number, state } = JSON.parse(json);
			pr = { number, state };
		} catch { /* no PR, or no gh */ }
		w.pr = pr;
		cache[w.branch] = { at: Date.now(), pr };
		dirty = true;
	}
	if (dirty) {
		try {
			mkdirSync(dirname(cachePath), { recursive: true });
			writeFileSync(cachePath, JSON.stringify(cache));
		} catch { /* cache is optional */ }
	}
	return out;
}

/**
 * A worktree belongs to an item when its branch carries the item's key or slug.
 * An umbrella item whose children use their own keys lists them in `branches:`,
 * because guessing across unrelated keys would produce false matches.
 */
function matchWorktrees(item, all) {
	const keys = [item.id && item.id.toLowerCase(), item.slug, ...(item.branches || [])]
		.filter(Boolean)
		.map((k) => String(k).toLowerCase());
	return all.filter((w) => w.branch && keys.some((k) => w.branch.toLowerCase().includes(k)));
}

function gather() {
	// Archive is listed but not embedded: the rules say it is not read unless asked.
	const work = collect('work');
	const reference = collect('reference');
	const archive = collect('archive').map((i) => ({ ...i, files: i.files.map((f) => ({ ...f, md: null })) , intro: null }));
	const trees = worktrees();
	for (const i of [...work, ...reference, ...archive]) i.worktrees = matchWorktrees(i, trees);
	return { work, reference, archive, worktrees: trees, root: ROOT, repo: resolveRepo() };
}

function writeIndex({ work, reference, archive }) {
	const row = (i) => {
		const where = i.isDir ? `${i.area}/${i.slug}/` : `${i.area}/${i.slug}.md`;
		const id = i.id ? `\`${i.id}\` ` : '';
		return `| ${id}${i.title} | ${i.status} | ${i.updated} | \`${where}\` | ${i.files.length} |`;
	};
	const table = (rows) =>
		rows.length
			? ['| Item | Status | Updated | Path | Files |', '| -- | -- | -- | -- | -- |', ...rows.map(row)].join('\n')
			: '_none_';
	const byStatus = (s) => work.filter((i) => i.status === s).sort((a, b) => b.mtime - a.mtime);

	writeFileSync(
		join(ROOT, 'INDEX.md'),
		`# Work index

Generated by \`deskbook index\`. Do not edit. See [RULES.md](RULES.md).

## Active

${table(byStatus('active'))}

## Blocked

${table(byStatus('blocked'))}

## Parked

${table(byStatus('parked'))}

## Reference

${table(reference.sort((a, b) => b.mtime - a.mtime))}

## Archive

${table(archive.sort((a, b) => b.mtime - a.mtime))}
`,
	);
	return { active: byStatus('active').length, total: work.length, reference: reference.length, archive: archive.length };
}

function cleanup(apply) {
	const actions = [];
	const now = Date.now();

	for (const item of collect('work')) {
		if (item.status === 'done' && now - item.mtime > DONE_AFTER_DAYS * DAY) {
			const days = Math.floor((now - item.mtime) / DAY);
			actions.push({
				what: `archive  ${item.area}/${item.slug}  (done ${days}d ago)`,
				run: () => {
					mkdirSync(join(ROOT, 'archive'), { recursive: true });
					const src = item.files.length > 1 ? join(ROOT, 'work', item.slug) : join(ROOT, 'work', `${item.slug}.md`);
					const dst = join(ROOT, 'archive', basename(src));
					renameSync(src, dst);
				},
			});
		}
	}

	// `run/` expires by entry. `.trash` is skipped as a container but its contents
	// expire individually, which is what makes `rm` recoverable for exactly a week.
	const expire = (dir, label) => {
		let entries = [];
		try { entries = readdirSync(dir); } catch { return; }
		for (const name of entries) {
			if (dir === join(ROOT, 'run') && name === '.trash') continue;
			if (name.startsWith('.') && dir === join(ROOT, 'run')) continue;
			const path = join(dir, name);
			const age = now - statSync(path).mtimeMs;
			if (age > RUN_AFTER_DAYS * DAY) {
				actions.push({
					what: `delete   ${label}/${name}  (${Math.floor(age / DAY)}d old)`,
					run: () => rmSync(path, { recursive: true, force: true }),
				});
			}
		}
	};
	expire(join(ROOT, 'run'), 'run');
	expire(join(ROOT, 'run', '.trash'), 'run/.trash');

	for (const line of mergedWorktrees()) {
		actions.push({ what: `worktree ${line.path.replace(/^.*\/\.claude\//, '.claude/')}  (${line.branch}: ${line.why})`, run: () => {
			execSync(`git -C ${JSON.stringify(line.repo)} worktree remove ${JSON.stringify(line.path)} --force`);
		} });
	}

	if (!actions.length) {
		console.log('  nothing to clean up');
		return;
	}
	for (const a of actions) console.log(`  ${apply ? '[done] ' : '[dry]  '}${a.what}`);
	if (apply) for (const a of actions) { try { a.run(); } catch (e) { console.log(`  !! failed: ${a.what} — ${e.message}`); } }
	else console.log(`\n  ${actions.length} action(s). Re-run with --apply to perform them.`);
}

/**
 * Worktrees safe to remove: agent worktrees under `.claude/worktrees/` whose branch
 * is merged. A squash merge leaves no ancestry, so ask `gh` about the PR first and
 * only fall back to an ancestry check. Worktrees outside that directory are never
 * touched, so a hand-made or third-party checkout is left alone.
 */
function mergedWorktrees() {
	const repo = resolveRepo();
	if (!repo) return [];
	const git = (cmd) => execSync(`git -C ${JSON.stringify(repo)} ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
	let listing;
	try { listing = git('worktree list --porcelain'); } catch { return []; }

	let ancestry = new Set();
	try {
		ancestry = new Set(
			git("branch --merged origin/HEAD --format=%(refname:short)").split('\n').map((x) => x.trim()).filter(Boolean),
		);
	} catch { /* no origin/HEAD configured */ }

	const prMerged = (branch) => {
		try {
			const out = execSync(`gh pr view ${JSON.stringify(branch)} --json state`, {
				encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], cwd: repo,
			});
			return JSON.parse(out).state === 'MERGED';
		} catch {
			return false;
		}
	};

	const results = [];
	let path = null;
	for (const line of listing.split('\n')) {
		if (line.startsWith('worktree ')) path = line.slice(9);
		if (line.startsWith('branch ') && path) {
			const branch = line.slice(7).replace('refs/heads/', '');
			// Only ever consider the agent worktree directory.
			if (!path.includes('/.claude/worktrees/')) continue;
			const why = prMerged(branch) ? 'PR merged' : ancestry.has(branch) ? 'branch merged' : null;
			if (why) results.push({ path, branch, repo, why });
		}
	}
	return results;
}

/**
 * Deletion is a move into `run/.trash/`, which the 7-day `run/` expiry then purges.
 * That makes a wrong click recoverable for a week without a separate retention rule.
 * `--purge` removes it immediately.
 */
function remove(target, purge) {
	if (!target) { console.error('usage: deskbook rm <slug> [--purge]'); process.exit(1); }
	for (const area of ['work', 'reference', 'archive']) {
		for (const candidate of [join(ROOT, area, target), join(ROOT, area, `${target}.md`)]) {
			if (!existsSync(candidate)) continue;
			if (purge) {
				rmSync(candidate, { recursive: true, force: true });
				console.log(`  purged ${area}/${basename(candidate)}`);
				return true;
			}
			const trash = join(ROOT, 'run', '.trash');
			mkdirSync(trash, { recursive: true });
			const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			renameSync(candidate, join(trash, `${basename(candidate)}.${stamp}`));
			console.log(`  moved ${area}/${basename(candidate)} to run/.trash — purged by cleanup after 7 days`);
			return true;
		}
	}
	console.error(`  not found: ${target}`);
	return false;
}

/** Paths this server will act on: the repo, the notes root, and real worktrees. */
function allowedPaths(snapshot) {
	const set = new Set([ROOT]);
	if (snapshot.repo) set.add(snapshot.repo);
	for (const w of snapshot.worktrees) set.add(w.path);
	for (const i of [...snapshot.work, ...snapshot.reference, ...snapshot.archive]) {
		// An item is a directory or a single file, and both forms may be asked for.
		set.add(join(ROOT, i.area, i.slug));
		set.add(join(ROOT, i.area, `${i.slug}.md`));
	}
	return set;
}

/**
 * Opens a directory, or reveals a file inside its directory. `open` on a plain file
 * would hand it to a text editor, or fail outright, so a file is revealed instead.
 */
function revealCmd(path) {
	let isFile = false;
	try { isFile = statSync(path).isFile(); } catch { /* may not exist yet */ }
	if (process.platform === 'darwin') return `open ${isFile ? '-R ' : ''}${JSON.stringify(path)}`;
	if (process.platform === 'win32') return isFile ? `explorer /select,${JSON.stringify(path)}` : `explorer ${JSON.stringify(path)}`;
	return `xdg-open ${JSON.stringify(isFile ? dirname(path) : path)}`;
}

/**
 * Launches through a generated shell script rather than inlining the command.
 * A context prompt contains quotes, newlines and backticks, and threading that
 * through AppleScript or cmd quoting is where this breaks.
 */
function launcher(slug, dir, run) {
	const dest = join(ROOT, 'run', '.launch');
	mkdirSync(dest, { recursive: true });
	const path = join(dest, `${slug || 'deskbook'}.sh`);
	writeFileSync(path, `#!/bin/sh\ncd ${shq(dir)} || exit 1\n${run}\n`, { mode: 0o755 });
	return path;
}
const shq = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;

/**
 * The prompt a new Claude session opens with. It carries the notes *path*, not the
 * notes text: a local session can read the files itself, and a short prompt beats a
 * 40 KB one pasted onto a command line.
 */
function sessionPrompt(item, notesPath) {
	const lines = [
		`Continue work on "${item.title}" (status: ${item.status}${item.id ? `, key: ${item.id}` : ''}).`,
		'',
		`Read the notes at ${notesPath} before doing anything else. They hold the plan and the decisions already taken.`,
	];
	if (item.links && item.links.length) lines.push('', 'Links:', ...item.links.map((l) => `- ${l.label}: ${l.url}`));
	if (item.worktrees && item.worktrees.length) {
		lines.push('', 'Branches:', ...item.worktrees.map((w) => `- ${w.branch}${w.pr ? ` (PR #${w.pr.number} ${w.pr.state.toLowerCase()})` : ''}`));
	}
	lines.push('', 'Then tell me what state the work is in and what you propose to do next.');
	return lines.join('\n');
}

/** Opens a terminal at a directory, optionally running a command in it. */
function terminalCmd(path, run) {
	if (process.platform === 'darwin') {
		const script = run ? `cd ${path.replace(/'/g, "'\\''")} && ${run}` : `cd ${path.replace(/'/g, "'\\''")}`;
		return `osascript -e 'tell application "Terminal" to do script "${script.replace(/"/g, '\\"')}"' -e 'tell application "Terminal" to activate'`;
	}
	if (process.platform === 'win32') {
		return run ? `start cmd /K "cd /d ${path} && ${run}"` : `start cmd /K "cd /d ${path}"`;
	}
	const inner = run ? `cd ${JSON.stringify(path)} && ${run}; exec $SHELL` : `cd ${JSON.stringify(path)}; exec $SHELL`;
	return `x-terminal-emulator -e bash -lc ${JSON.stringify(inner)} || gnome-terminal --working-directory=${JSON.stringify(path)}`;
}

/**
 * A published artifact cannot reach the filesystem, so opening folders, launching
 * terminals and removing worktrees only work from a local origin. This serves the
 * same page with `live` set and exposes those actions.
 *
 * Bound to loopback. Every mutating route needs an `X-Deskbook` header, which a
 * cross-site request cannot set without a preflight it will fail, and every path is
 * checked against a set the server built itself.
 */
async function serve(portArg, openBrowser) {
	const { createServer } = await import('node:http');
	const port = Number(portArg) || 4478;
	let snapshot = null;
	let cached = null;
	const build = () => {
		snapshot = gather();
		cached = renderDashboard(snapshot, true);
		return cached;
	};
	const invalidate = () => { cached = null; snapshot = null; };
	const page = () => cached || build();

	const readBody = (req) =>
		new Promise((resolve) => {
			let raw = '';
			req.on('data', (c) => { raw += c; if (raw.length > 8192) req.destroy(); });
			req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
		});

	const server = createServer(async (req, res) => {
		const send = (code, obj) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(obj));
		};

		if (req.method === 'GET') {
			if (req.url === '/refresh') { invalidate(); send(200, { ok: true }); return; }
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
			res.end(page());
			return;
		}

		if (req.headers['x-deskbook'] !== '1') { send(403, { ok: false, error: 'forbidden' }); return; }
		const body = await readBody(req);
		if (!snapshot) build();
		const allowed = allowedPaths(snapshot);

		const runFor = (path, cmd) => {
			if (!path || !allowed.has(path)) return send(400, { ok: false, error: 'path not recognised' });
			try {
				execSync(cmd, { stdio: 'ignore' });
				return send(200, { ok: true });
			} catch (e) {
				return send(500, { ok: false, error: e.message.split('\n')[0] });
			}
		};

		switch (req.url) {
			case '/reveal':
				return runFor(body.path, revealCmd(body.path));
			case '/terminal':
				return runFor(body.path, terminalCmd(body.path));
			case '/claude': {
				if (!body.path || !allowed.has(body.path)) return send(400, { ok: false, error: 'path not recognised' });
				const item = [...snapshot.work, ...snapshot.reference, ...snapshot.archive]
					.find((i) => i.slug === body.slug);
				if (!item) return send(400, { ok: false, error: 'unknown item' });
				const notesPath = join(ROOT, item.area, item.isDir ? item.slug : `${item.slug}.md`);
				const script = launcher(item.slug, body.path, `exec claude ${shq(sessionPrompt(item, notesPath))}`);
				try {
					execSync(terminalCmd(body.path, shq(script)), { stdio: 'ignore' });
					return send(200, { ok: true });
				} catch (e) {
					return send(500, { ok: false, error: e.message.split('\n')[0] });
				}
			}
			case '/delete': {
				const ok = (() => { try { return remove(body.slug, false); } catch { return false; } })();
				if (ok) invalidate();
				return send(ok ? 200 : 404, { ok });
			}
			case '/worktree/remove': {
				const w = snapshot.worktrees.find((x) => x.path === body.path);
				if (!w) return send(400, { ok: false, error: 'not a worktree of this repository' });
				if (w.main) return send(400, { ok: false, error: 'this is the main checkout — git cannot remove it' });
				try {
					execSync(`git -C ${JSON.stringify(snapshot.repo)} worktree remove ${JSON.stringify(w.path)} --force`, { stdio: 'ignore' });
					invalidate();
					return send(200, { ok: true });
				} catch (e) {
					return send(500, { ok: false, error: e.message.split('\n')[0] });
				}
			}
			default:
				return send(404, { ok: false, error: 'no such route' });
		}
	});

	server.listen(port, '127.0.0.1', () => {
		const url = `http://127.0.0.1:${port}`;
		console.log(`  deskbook live at ${url}`);
		console.log('  folder, terminal, Claude session and worktree removal all work here');
		console.log('  ctrl-c to stop');
		if (openBrowser) { try { execSync(revealCmd(url)); } catch { /* no browser */ } }
	});
}

/** Removes a worktree from the command line, for parity with the live page. */
function worktreeRemove(target) {
	const repo = resolveRepo();
	if (!repo) { console.error('  not a git repository'); process.exit(1); }
	const all = worktrees();
	const w = all.find((x) => x.path === target || x.branch === target || (x.path || '').endsWith('/' + target));
	if (!w) {
		console.error(`  not a worktree: ${target}\n  known:\n${all.map((x) => '    ' + (x.branch || x.head) + '  ' + x.path).join('\n')}`);
		process.exit(1);
	}
	execSync(`git -C ${JSON.stringify(repo)} worktree remove ${JSON.stringify(w.path)} --force`, { stdio: 'inherit' });
	console.log(`  removed ${w.path}`);
}

/**
 * Installs a `deskbook` command on PATH. The plugin only provides `/deskbook`
 * inside Claude Code, so without this the bare command does not exist and every
 * example that shows `deskbook ...` would be wrong in a terminal.
 */
function shim(dirArg) {
	const dir = dirArg || join(homedir(), '.local', 'bin');
	mkdirSync(dir, { recursive: true });
	const dest = join(dir, 'deskbook');
	const target = join(HERE, 'deskbook.mjs');
	writeFileSync(dest, `#!/bin/sh\nexec node ${shq(target)} "$@"\n`, { mode: 0o755 });
	console.log(`  installed ${dest}`);
	const onPath = (process.env.PATH || '').split(':').includes(dir);
	if (onPath) console.log('  `deskbook` is ready to use');
	else console.log(`  ${dir} is not on your PATH yet. Add it:\n    export PATH="${dir}:$PATH"`);
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor',
	'coverage', 'target', '.next', '.turbo', '.venv', '__pycache__', 'worktrees', 'generated', 'memory']);
/** Files a repository owns rather than notes about the work. */
const NOT_NOTES = /^(readme|license|licence|changelog|contributing|code_of_conduct|security|agents|claude|notice|authors|index)/i;
/** Names that read as somebody's working notes rather than product documentation. */
const NOTE_NAME = /(plan|notes?|research|design|todo|handover|handoff|scratch|rfc|adr|walkthrough|investigation|analysis|findings|spec|proposal|retro|postmortem)/i;
const NOTE_DIRS = ['docs', 'doc', 'notes', 'design', 'plans', 'planning', 'rfc', 'rfcs', 'adr', '.claude'];

function scanDir(dir, depth, out) {
	if (depth < 0) return out;
	let entries;
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
	for (const e of entries) {
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			scanDir(join(dir, e.name), depth - 1, out);
		} else if (e.name.endsWith('.md') && !NOT_NOTES.test(e.name)) {
			out.push(join(dir, e.name));
		}
	}
	return out;
}

/**
 * Finds markdown that looks like work notes, so a first run can offer to adopt what
 * already exists instead of starting empty.
 *
 * Ranked by how strong the signal is. Untracked or ignored markdown in a repository
 * is almost always somebody's own notes, whereas committed files under `docs/` are
 * usually product documentation, so those are only offered when the filename reads
 * like notes. Candidates are copied, never moved.
 */
function adoptCandidates(all = false) {
	const repo = resolveRepo();
	const seen = new Set();
	const found = [];
	const add = (path, why) => {
		if (seen.has(path) || path.startsWith(ROOT)) return;
		let text = '';
		try { text = readFileSync(path, 'utf8'); } catch { return; }
		let st;
		try { st = statSync(path); } catch { return; }
		if (!st.isFile()) return;
		seen.add(path);
		found.push({
			path,
			rel: repo && path.startsWith(repo) ? relative(repo, path) : path,
			why,
			bytes: st.size,
			updated: new Date(st.mtimeMs).toISOString().slice(0, 10),
			title: heading(`---\n---\n${text}`) || basename(path, '.md'),
			slug: basename(path, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
			hasFrontMatter: text.startsWith('---\n'),
		});
	};

	// Strongest signal: markdown git is not tracking.
	if (repo) {
		for (const flag of ['--others', '--others --ignored']) {
			let listing = '';
			try {
				listing = execSync(`git -C ${JSON.stringify(repo)} ls-files ${flag} --exclude-standard -- "*.md"`, {
					encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 8 * 1024 * 1024,
				});
			} catch { /* not a repo */ }
			for (const rel of listing.split('\n').map((x) => x.trim()).filter(Boolean)) {
				if (NOT_NOTES.test(basename(rel))) continue;
				if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
				add(join(repo, rel), flag.includes('ignored') ? 'ignored by git' : 'untracked');
			}
		}
	}

	// The project's own Claude directory, minus what deskbook and memory already own.
	const projectDir = dirname(ROOT);
	if (existsSync(projectDir)) for (const f of scanDir(projectDir, 2, [])) add(f, 'claude project dir');

	// Committed files, only when the name reads like notes.
	if (repo) {
		const roots = [[repo, 0], ...NOTE_DIRS.filter((d) => existsSync(join(repo, d))).map((d) => [join(repo, d), 2])];
		for (const [dir, depth] of roots) {
			for (const f of scanDir(dir, depth, [])) {
				if (!all && !NOTE_NAME.test(basename(f))) continue;
				add(f, 'name reads like notes');
			}
		}
	}

	const rank = { untracked: 0, 'ignored by git': 1, 'claude project dir': 2, 'name reads like notes': 3 };
	return found.sort((a, b) => (rank[a.why] - rank[b.why]) || b.updated.localeCompare(a.updated));
}

function adopt(argv) {
	const takeArg = argv.find((a) => a.startsWith('--take='))?.slice(7)
		|| (argv.includes('--take') ? argv[argv.indexOf('--take') + 1] : null);
	const asArg = argv.includes('--as') ? argv[argv.indexOf('--as') + 1] : null;

	if (!takeArg) {
		const list = adoptCandidates(argv.includes('--all'));
		if (argv.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return; }
		if (!list.length) { console.log('  no candidate notes found'); return; }
		const shown = argv.includes('--all') ? list : list.slice(0, 30);
		console.log(`  ${list.length} file(s) that look like work notes:\n`);
		let why = null;
		for (const c of shown) {
			if (c.why !== why) { why = c.why; console.log(`  [${why}]`); }
			console.log(`    ${c.updated}  ${String(c.bytes).padStart(7)} B  ${c.rel}`);
			console.log(`                ${c.title}`);
		}
		if (shown.length < list.length) console.log(`\n  ...and ${list.length - shown.length} more (--all to list every one)`);
		console.log(`\n  Adopt with:  deskbook adopt --take <path>[,<path>...] [--as <slug>]`);
		console.log('  Files are copied, never moved.');
		return;
	}

	const paths = takeArg.split(',').map((x) => x.trim()).filter(Boolean);
	if (asArg && paths.length > 1) { console.error('  --as names one file, but several were given'); process.exit(1); }
	for (const raw of paths) {
		const src = raw.startsWith('/') ? raw : join(resolveRepo() || process.cwd(), raw);
		if (!existsSync(src)) { console.error(`  missing: ${raw}`); continue; }
		let text = readFileSync(src, 'utf8');
		const slug = asArg || basename(src, '.md').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
		const dst = join(ROOT, 'work', `${slug}.md`);
		if (existsSync(dst)) { console.error(`  exists already, skipped: work/${slug}.md`); continue; }
		if (!text.startsWith('---\n')) {
			const title = heading(`---\n---\n${text}`) || titleCase(slug);
			text = `---\ntitle: ${title}\nstatus: active\n---\n\n${text.replace(/^\n+/, '')}`;
		}
		writeFileSync(dst, text);
		console.log(`  adopted work/${slug}.md  (copied from ${src})`);
	}
}

/**
 * A paste-ready context block for resuming work, or for handing a project to a
 * session that cannot read this disk (a cloud agent, a colleague). Self-contained
 * by default, because a path is useless to a machine that cannot see it.
 */
function brief(target, short) {
	if (!target) { console.error('usage: deskbook brief <slug> [--short]'); process.exit(1); }
	const data = gather();
	const all = [...data.work, ...data.reference, ...data.archive];
	const it = all.find((i) => i.slug === target) || all.find((i) => i.slug.includes(target)) ||
		all.find((i) => (i.id || '').toLowerCase() === target.toLowerCase());
	if (!it) {
		console.error(`  not found: ${target}\n  known: ${all.map((i) => i.slug).join(', ')}`);
		process.exit(1);
	}

	const out = [];
	out.push(`# ${it.title}`, '');
	out.push(`**Status:** ${it.status}${it.id ? ` · **Key:** ${it.id}` : ''} · **Updated:** ${it.updated}`);
	if (it.tags.length) out.push(`**Tags:** ${it.tags.join(', ')}`);
	out.push('');
	if (it.links.length) {
		out.push('## Links', '');
		for (const l of it.links) out.push(`- ${l.label}: ${l.url}`);
		out.push('');
	}
	if (it.worktrees.length) {
		out.push('## Branches and worktrees', '');
		for (const w of it.worktrees) {
			const pr = w.pr ? ` — PR #${w.pr.number} ${w.pr.state.toLowerCase()}` : '';
			out.push(`- \`${w.branch}\`${pr}`);
		}
		out.push('');
	}
	if (data.repo) out.push(`**Repository:** ${data.repo}`, '');

	const docs = it.files.filter((f) => f.md !== null);
	if (short) {
		out.push('## Contents', '');
		for (const f of docs) {
			out.push(`### ${f.name}`, '');
			const heads = f.md.split('\n').filter((l) => /^#{1,3}\s/.test(l)).slice(0, 25);
			out.push(...(heads.length ? heads.map((h) => `- ${h.replace(/^#+\s*/, '')}`) : ['_no headings_']), '');
		}
		out.push(`_Outline only. Run \`deskbook brief ${it.slug}\` for the full text._`);
	} else {
		for (const f of docs) out.push('---', '', `## ${f.name}`, '', f.md.trimEnd(), '');
		const other = it.files.filter((f) => f.md === null);
		if (other.length) out.push('---', '', '## Other files', '', ...other.map((f) => `- ${f.name} (${f.bytes} B)`), '');
	}
	out.push('---', '', `_Notes live at ${join(ROOT, it.area, it.slug)} on the original machine._`);
	console.log(out.join('\n'));
}

function create(slug) {
	if (!slug) { console.error('usage: deskbook new <slug>'); process.exit(1); }
	const path = join(ROOT, 'work', `${slug}.md`);
	writeFileSync(
		path,
		`---
title: ${titleCase(slug)}
status: active
---

# ${titleCase(slug)}

`,
		{ flag: 'wx' },
	);
	console.log(`  created work/${slug}.md`);
}

for (const d of ['work', 'reference', 'archive', 'run']) mkdirSync(join(ROOT, d), { recursive: true });

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'shim') shim(arg);
else if (cmd === 'init') {
	const dst = join(ROOT, 'RULES.md');
	if (existsSync(dst)) console.log(`  RULES.md already present at ${dst}`);
	else {
		writeFileSync(dst, readFileSync(join(HERE, 'RULES.template.md'), 'utf8'));
		console.log(`  deskbook ready at ${ROOT}`);
	}
} else if (cmd === 'new') create(arg);
else if (cmd === 'rm') remove(arg, process.argv.includes('--purge'));
else if (cmd === 'brief') brief(arg, process.argv.includes('--short'));
else if (cmd === 'adopt') adopt(process.argv.slice(3));
else if (cmd === 'serve') await serve(arg, process.argv.includes('--open'));
else if (cmd === 'worktree') worktreeRemove(process.argv[4] || arg);
else if (cmd === 'cleanup') cleanup(arg === '--apply');
else if (cmd === 'index' || !cmd) {
	const data = gather();
	const counts = writeIndex(data);
	const html = renderDashboard(data);
	const out = join(ROOT, 'dashboard.html');
	writeFileSync(out, html);
	console.log(`  INDEX.md + dashboard.html written — ${counts.active} active, ${counts.total} in work, ${counts.reference} reference, ${counts.archive} archived`);
	// A page that throws renders blank with no other symptom, so prove it renders.
	try {
		execSync(`node ${JSON.stringify(join(HERE, 'verify-page.mjs'))} ${JSON.stringify(out)}`, { stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		const detail = [e.stdout, e.stderr].filter(Boolean).map(String).join('').trim();
		console.error(`\n  !! dashboard.html does not render:\n${detail.replace(/^/gm, '  ')}`);
		process.exitCode = 1;
	}
} else {
	console.error(`unknown command: ${cmd}\n  deskbook shim [dir] | init | adopt | [index] | new <slug> | brief <slug> [--short]\n  deskbook rm <slug> [--purge] | worktree rm <branch> | serve [port] [--open] | cleanup [--apply]`);
	process.exit(1);
}

function renderDashboard(data, live = false) {
	const template = readFileSync(join(HERE, 'dashboard.template.html'), 'utf8');
	const generated = new Date().toISOString().slice(0, 10);
	return template
		// `</script>` inside a note would end the script block early, so neutralise it.
		.replace('/*__DATA__*/null', JSON.stringify({ ...data, generated, live }).replace(/<\//g, '<\\/'))
		.replace(/__GENERATED__/g, generated);
}
