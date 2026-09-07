#!/usr/bin/env node
// Runs every command in a throwaway repo. A range edit that deletes a function
// shows up here as a failing command rather than a silent break at the call site.
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'deskbook.mjs');
const root = mkdtempSync(join(tmpdir(), 'deskbook-selftest-'));
const repo = join(root, 'repo');
const config = join(root, 'config');
let pass = 0;
let fail = 0;

mkdirSync(join(repo, 'notes'), { recursive: true });
execSync('git init -q', { cwd: repo });
writeFileSync(join(repo, 'a.md'), '# a\n');
writeFileSync(join(repo, 'notes', 'widget-plan.md'), '# Widget plan\n\nSteps.\n');
execSync('git add a.md && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: repo, shell: '/bin/sh' });

const run = (args, opts = {}) =>
  execFileSync('node', [CLI, ...args], {
    cwd: opts.cwd || repo,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: config, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const check = (name, fn) => {
  try {
    const out = fn();
    console.log(`  ok    ${name}`);
    pass++;
    return out;
  } catch (e) {
    const detail = [e.stdout, e.stderr, e.message].filter(Boolean).map(String).join(' ').trim().split('\n')[0];
    console.log(`  FAIL  ${name}\n          ${detail}`);
    fail++;
    return '';
  }
};
const expect = (name, fn, needle) =>
  check(name, () => {
    const out = fn();
    if (needle && !out.includes(needle)) throw new Error(`expected "${needle}" in: ${out.slice(0, 160)}`);
    return out;
  });

const notesDir = () => join(config, 'projects', readdirSync(join(config, 'projects'))[0], 'notes');

// These run before `init` on purpose. A repository nobody initialised must come
// back untouched, so the session hook can stay silent in it.
const untouched = () => {
  if (existsSync(join(config, 'projects'))) throw new Error('a notes root was created before init');
};
const refuses = (name, args) =>
  check(name, () => {
    let stderr = null;
    try { run(args); } catch (e) { stderr = String(e.stderr || ''); }
    if (stderr === null) throw new Error('should have exited non-zero');
    if (!stderr.includes('deskbook init')) {
      throw new Error(`expected a nudge to init, got: ${stderr.trim().split('\n')[0]}`);
    }
    untouched();
    return stderr;
  });

refuses('index refuses before init', ['index']);
refuses('new refuses before init', ['new', 'too-early']);

check('session is silent before init, exits 0, and writes nothing', () => {
  const out = run(['session']);
  if (out.trim() !== '') throw new Error(`expected no output, got: ${out.trim().slice(0, 80)}`);
  untouched();
  return 'ok';
});

check('where answers before init, and writes nothing', () => {
  const out = run(['where']);
  if (!out.trim().endsWith('notes')) throw new Error(`expected a notes path, got: ${out.trim()}`);
  untouched();
  return out;
});

expect('init', () => run(['init']), 'deskbook ready');
check('session reads only: prints the root, writes no INDEX.md', () => {
  const out = run(['session']);
  if (!out.includes('Deskbook:')) throw new Error(`expected the notes path line, got: ${out.slice(0, 80)}`);
  if (existsSync(join(notesDir(), 'INDEX.md'))) throw new Error('session wrote INDEX.md');
  return out;
});
expect('index on an empty notebook', () => run(['index']), 'dashboard.html written');
expect('where', () => run(['where']), 'notes');
expect('adopt (scan)', () => run(['adopt']), 'widget-plan.md');
expect('adopt --json', () => run(['adopt', '--json']), '"why"');
expect('adopt --take', () => run(['adopt', '--take', 'notes/widget-plan.md']), 'adopted work/widget-plan.md');
expect('new', () => run(['new', 'a-task']), 'created work/a-task.md');


check('new writes the index', () => {
  run(['new', 'indexed-by-new']);
  const idx = readFileSync(join(notesDir(), 'INDEX.md'), 'utf8');
  if (!idx.includes('indexed-by-new')) throw new Error('INDEX.md does not list the item new just created');
  return 'ok';
});

expect('session lists active items', () => run(['session']), 'work/indexed-by-new.md');

check('new refuses a duplicate slug without a stack trace', () => {
  let stderr = null;
  try { run(['new', 'indexed-by-new']); } catch (e) { stderr = String(e.stderr || ''); }
  if (stderr === null) throw new Error('should have exited non-zero');
  if (/EEXIST|openSync/.test(stderr)) throw new Error('leaked a stack trace');
  if (!stderr.includes('already')) throw new Error(`expected a plain message, got: ${stderr.trim().split('\n')[0]}`);
  return stderr;
});
check('brief labels links with the key the URL carries', () => {
  writeFileSync(join(notesDir(), 'work', 'linked.md'), `---
title: Linked
status: active
links:
  - https://linear.app/acme/issue/API-214/some-slug
  - https://linear.app/acme/issue/API-271
  - https://github.com/acme/repo/pull/37667
  - Spec: https://docs.example.com/spec
---
# Linked
`);
  const out = run(['brief', 'linked', '--short']);
  for (const needle of ['- Linear API-214: ', '- Linear API-271: ', '- GitHub #37667: ', '- Spec: https://docs.example.com/spec']) {
    if (!out.includes(needle)) throw new Error(`expected "${needle}" in brief`);
  }
  return out;
});

// A branch's review joins the item's links through the same path as a hand-written
// link. `gh` is stubbed on PATH so the test needs no network and no login.
check('a branch\'s pull request joins the links, once, with its state', () => {
  const stubbin = join(root, 'stubbin');
  mkdirSync(stubbin, { recursive: true });
  writeFileSync(join(stubbin, 'gh'), `#!/bin/sh
case "$1 $2" in
  "pr view") echo '{"number":42,"state":"OPEN","url":"https://github.com/acme/repo/pull/42","isDraft":false}' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  execSync('git worktree add -q .claude/worktrees/wt-pr -b wt-pr', { cwd: repo });
  writeFileSync(join(notesDir(), 'work', 'pr-linked.md'), `---
title: PR linked
status: active
branches: [wt-pr]
links:
  - https://github.com/acme/repo/pull/42
---
# PR linked
`);
  const out = run(['brief', 'pr-linked', '--short'], { env: { PATH: stubbin + ':' + process.env.PATH } });
  const line = '- GitHub #42 (open): https://github.com/acme/repo/pull/42';
  const n = out.split(line).length - 1;
  if (n !== 1) throw new Error(`expected "${line}" exactly once, saw it ${n} times`);
  return out;
});

// The served page must reflect a note written after the server started: a hand
// edit or a `deskbook new` from a terminal are not visible to the server otherwise.
await (async () => {
  const name = 'serve reflects a note written after it started';
  const port = 4600 + Math.floor(Math.random() * 400);
  const url = `http://127.0.0.1:${port}/`;
  const srv = spawn('node', [CLI, 'serve', String(port)], {
    cwd: repo, env: { ...process.env, CLAUDE_CONFIG_DIR: config }, stdio: 'ignore',
  });
  try {
    let up = false;
    for (let i = 0; i < 50 && !up; i++) {
      try { up = (await fetch(url)).ok; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    if (!up) throw new Error('server did not start');
    const before = await (await fetch(url)).text();
    run(['new', 'written-after-serve']);
    const after = await (await fetch(url)).text();
    if (before.includes('written-after-serve')) throw new Error('slug present before it was created');
    if (!after.includes('written-after-serve')) throw new Error('served page does not show the new note');
    console.log(`  ok    ${name}`); pass++;
  } catch (e) {
    console.log(`  FAIL  ${name}\n          ${e.message}`); fail++;
  } finally { srv.kill(); }
})();

expect('index', () => run(['index']), 'dashboard.html written');
expect('brief', () => run(['brief', 'a-task']), '**Status:** active');
expect('brief --short', () => run(['brief', 'widget-plan', '--short']), '## Contents');
expect('cleanup (dry)', () => run(['cleanup']), '');
expect('rm', () => run(['rm', 'a-task']), 'run/.trash');
expect('rm --purge', () => run(['rm', 'widget-plan', '--purge']), 'purged');
expect('shim', () => run(['shim', join(root, 'bin')]), 'installed');

check('worktree rm', () => {
  execSync('git worktree add -q .claude/worktrees/wt-x -b wt-x', { cwd: repo });
  const out = run(['worktree', 'rm', 'wt-x']);
  if (existsSync(join(repo, '.claude/worktrees/wt-x'))) throw new Error('worktree still on disk');
  if (!execSync('git branch --list wt-x', { cwd: repo, encoding: 'utf8' }).includes('wt-x')) {
    throw new Error('branch was destroyed; it must survive');
  }
  return out;
});

check('unknown command exits non-zero', () => {
  try { run(['no-such-command']); } catch (e) {
    if (!String(e.stderr).includes('unknown command')) throw new Error('wrong message');
    return 'ok';
  }
  throw new Error('should have failed');
});

check('hooks.json registers SessionStart -> deskbook session', () => {
  const hooks = JSON.parse(readFileSync(join(dirname(CLI), '..', 'hooks', 'hooks.json'), 'utf8'));
  const entries = hooks.hooks?.SessionStart;
  if (!Array.isArray(entries) || !entries.length) throw new Error('no SessionStart entry');
  const cmd = entries[0].hooks?.[0]?.command || '';
  if (!/deskbook\.mjs" session$/.test(cmd)) throw new Error(`command does not run session: ${cmd}`);
  if (!cmd.includes('${CLAUDE_PLUGIN_ROOT}')) throw new Error('command must resolve the plugin root, not hardcode a path');
  return 'ok';
});

check('dashboard.html renders', () => {
  const notes = join(config, 'projects', readdirSync(join(config, 'projects'))[0], 'notes');
  return execFileSync('node', [join(dirname(CLI), 'verify-page.mjs'), join(notes, 'dashboard.html')], { encoding: 'utf8' });
});

rmSync(root, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
