# Deskbook — how work notes are organised

One rule matters most: **default to a single file.** A directory is an
escalation, not a starting point.

## Layout

```
notes/
  INDEX.md      generated, do not edit
  RULES.md      this file
  work/         live work. A FILE per task, a DIRECTORY only when needed.
  reference/    durable docs not tied to any one task
  archive/      finished work. Never read unless asked.
  run/          disposable: env files, logs, instance folders, scratch output
```

## Naming

`<ticket-id>-<two-or-three-word-slug>`, lowercase, always in that order.
No ticket? Use the slug alone.

    work/api-240-param-zod-schema.md          a task
    work/api-85-executions/                   a project
    work/pr-radar/                            no ticket yet

The name must be guessable from a ticket number, so a path never needs a
directory listing to find.

## Every work item starts with frontmatter

```yaml
---
title: Executions schema-first migration
status: active
id: API-85
tags: [public-api, migration]
links:
  - https://your-tracker.example/issue/API-85
  - https://github.com/acme/repo/pull/1234
  - Spec: https://docs.example.com/spec
branches: [api-205, api-206]
---
```

`title` and `status` are required. `status` is one of **active · blocked ·
parked · done**. Everything else is optional.

`id` is any key your tracker uses, or omitted entirely. **`links` are plain
URLs from any tool** — the label is taken from the host, so Jira, GitHub,
Notion, Shortcut, ClickUp and the rest all work with no configuration. Write
`Label: https://…` to name one yourself.

`branches` is only needed by an umbrella item whose child branches use
different keys; it decides which worktrees the item shows.

Do not add an `updated` field; the tool reads the file's modification time.

For a directory, the frontmatter goes in its `README.md`, which also says
what each file in the directory is for. That README is always read first.

## When a file becomes a directory

Promote only when a second file genuinely has to exist. Then:

```
work/api-85-executions/
  README.md     frontmatter + what is in here
  plan.md       the one plan
  research.md   findings that outlived the plan
  tools/        scripts, harnesses, collections that serve THIS work
```

Nothing else at the top level. No `notes.md`, no `misc.md`.

## The four anti-bloat rules

1. **One plan per work item.** Rewrite it in place. Never `plan-v2.md`,
   never a "corrections" section appended to the end.
2. **No file per pull request.** A PR describes itself. Notes hold only what
   the PR cannot: a measurement, a rejected approach, a constraint.
3. **Tools live inside the work item** that needs them, under `tools/`.
   Never as a sibling directory.
4. **Nothing disposable in `work/`.** Env files, logs, server data folders and
   scratch scripts go to `run/<slug>/`, which is deleted without asking.

## Cleanup

Mechanical, so it needs no judgement:

| Trigger | Action |
| -- | -- |
| `status: done` for 14 days | move the whole item to `archive/` |
| anything in `run/` older than 7 days | delete |
| worktree under `.claude/worktrees/` whose PR is merged | remove |
| superseded plan still present | delete it, the current plan is the plan |

`cleanup` prints and changes nothing until you pass `--apply`. Worktrees
outside `.claude/worktrees/` are never touched.

## Commands

The tool ships with the `deskbook` plugin. Inside Claude Code use `/deskbook
<command>`. For a terminal, run `/deskbook shim` once to put a `deskbook`
command on your PATH. Always run it from the repository, so the notes root
resolves correctly.

    deskbook shim [dir]     install a `deskbook` command on PATH
    deskbook index          rewrite INDEX.md and dashboard.html
    deskbook new <slug>     create a task file with frontmatter
    deskbook adopt          find existing notes (--take a.md,b.md to bring them in)
    deskbook brief <slug>   paste-ready context block (--short for an outline)
    deskbook rm <slug>      move an item to run/.trash (add --purge to skip it)
    deskbook worktree rm <branch>   remove a worktree (the branch survives)
    deskbook serve [port]   local dashboard where every action works (--open a browser)
    deskbook cleanup        show what cleanup would do
    deskbook cleanup --apply

## Worktrees

The dashboard lists every git worktree of the repository, with its branch and
pull-request state, and shows the ones belonging to each item. A worktree whose
pull request has merged is safe to remove, and `cleanup` offers to remove those
under `.claude/worktrees/`. Worktrees anywhere else are never touched.

## Resuming, and handing work over

`deskbook brief <slug>` prints one self-contained block: status, links, branches
with pull-request state, and the full text of every note in the item. Paste it
into a new session — local, cloud, or a colleague's — and that session has the
context without needing to read this disk.

    deskbook brief api-85            # everything, paste-ready
    deskbook brief api-85 --short    # outline only, for a quick catch-up
    deskbook brief API-207           # a tracker key works too

The dashboard has the same thing as **copy brief** and **copy outline** buttons,
which is the fastest route when you already have the page open.

A cloud agent cannot see your notes directory, so paths alone will not do. The
brief embeds the content for that reason, and still prints the original path at
the end for anyone working on the same machine.

## Deleting an item

`deskbook rm <slug>` moves it to `run/.trash/`, where cleanup purges it after
7 days. `--purge` removes it at once.

The published dashboard is a static page and cannot touch your disk, so its
buttons copy a path or a command instead. Run `deskbook serve` for the local
dashboard, where Folder, Terminal, Claude session, worktree removal and delete
all work for real.
