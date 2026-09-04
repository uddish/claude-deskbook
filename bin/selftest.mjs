#!/usr/bin/env node
// Runs every command in a throwaway repo. A range edit that deletes a function
// shows up here as a failing command rather than a silent break at the call site.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
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
    env: { ...process.env, CLAUDE_CONFIG_DIR: config },
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

expect('init', () => run(['init']), 'deskbook ready');
expect('adopt (scan)', () => run(['adopt']), 'widget-plan.md');
expect('adopt --json', () => run(['adopt', '--json']), '"why"');
expect('adopt --take', () => run(['adopt', '--take', 'notes/widget-plan.md']), 'adopted work/widget-plan.md');
expect('new', () => run(['new', 'a-task']), 'created work/a-task.md');
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

check('dashboard.html renders', () => {
  const notes = join(config, 'projects', readdirSync(join(config, 'projects'))[0], 'notes');
  return execFileSync('node', [join(dirname(CLI), 'verify-page.mjs'), join(notes, 'dashboard.html')], { encoding: 'utf8' });
});

rmSync(root, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
