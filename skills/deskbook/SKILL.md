---
name: deskbook
description: >-
  Keeps work notes in one predictable place instead of scattered markdown. Use
  when starting a new task or project that needs notes, when writing a plan or
  research document, when asked where notes live or what is in progress, when
  notes need indexing or cleaning up, or when the user says /deskbook. Also use
  before creating any new notes directory, so the layout stays consistent.
allowed-tools: Bash(node:*), Bash(git:*), Bash(gh:*), Read, Write, Edit, Glob, Grep
---

# Deskbook

Work notes live under one root, resolved in this order:

1. `$DESKBOOK_HOME`
2. `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd-with-slashes-as-dashes>/notes`

Read `RULES.md` at that root before creating anything. If it is missing, run
`node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs init` first.

## First run in a repository

When the notes root has no `RULES.md`, deskbook is not set up here yet. Do this,
in order:

1. `deskbook init` — creates the layout and installs `RULES.md`. Tell the user
   the absolute path it prints; it is outside the repository and easy to lose.
2. `deskbook adopt --json` — finds markdown that already looks like work notes.
3. **Ask the user which ones to bring in.** Show them the list grouped by the
   `why` field, newest first, with the title and size. Do not adopt anything
   without being asked to: some of those files belong to the repository, not to
   them.
4. `deskbook adopt --take <path>[,<path>...]` for what they picked. Files are
   copied, never moved, and front matter is added when it is missing.
5. `deskbook index`, then offer to publish `dashboard.html`.

The `why` field says how strong the signal is:

| `why` | Means |
| -- | -- |
| `untracked` | git is not tracking it, so it is almost certainly personal notes |
| `ignored by git` | same, via `.gitignore` |
| `claude project dir` | already beside this project's Claude files |
| `name reads like notes` | committed, but named `plan`, `design`, `rfc`, and such |

Committed files are only offered when the name reads like notes, because a
repository's `docs/` is usually product documentation. `--all` lifts that.

An empty result is a normal answer, not a failure. Say so and move on.

## The layout

```
work/         live work. A FILE per task, a DIRECTORY only when needed.
reference/    durable docs and tools not tied to one task
archive/      finished work. Do not read unless asked.
run/          disposable: env files, logs, instance folders, scratch output
INDEX.md      generated
```

## Rules to follow when you create notes

**Default to a single file.** `work/<ticket-id>-<short-slug>.md`. A directory is
an escalation, taken only when a second file genuinely has to exist. Most tasks
never need one.

**Name it so the path is guessable** from a ticket number: `api-240-param-zod-schema.md`.
No ticket, no prefix.

**Start every item with front matter.**

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

For a directory, the front matter goes in `README.md`, which also lists what
each file in the directory is for. Read that README first.

**When promoting a file to a directory**, the only top-level names are
`README.md`, `plan.md`, `research.md` and `tools/`. Nothing else.

## The four anti-bloat rules

1. **One plan per item.** Rewrite it in place. Never `plan-v2.md`, never an
   appended "corrections" section.
2. **No file per pull request.** A PR describes itself. Notes hold only what the
   PR cannot: a measurement, a rejected approach, a constraint.
3. **Tools live inside the item** that needs them, under `tools/`. Never as a
   sibling directory. A tool used by several items goes in `reference/`.
4. **Nothing disposable in `work/`.** Env files, logs, server data folders and
   scratch scripts go to `run/<slug>/`, which is deleted without asking.

## Commands

Run from the working directory so the root resolves correctly:

The bare `deskbook` command does not exist unless the user has run
`deskbook shim`, so always invoke the script by path:

```bash
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs shim        # optional: a PATH command
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs init
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs where         # the notes root, alone on stdout
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs session       # what the session-start hook runs; read-only
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs adopt --json     # find existing notes
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs adopt --take a.md,b.md
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs index          # INDEX.md + dashboard.html
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs new <slug>     # a task file with front matter
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs brief <slug>   # paste-ready context block
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs rm <slug>      # move to run/.trash
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs serve --open    # local dashboard, every action works
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs worktree rm <branch>
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs cleanup        # dry run
node ${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs cleanup --apply
```

### Operating notes

- **The `Deskbook:` block at the top of a session is this plugin's hook.** Its
  path is where notes go. Trust it over any other memory or guess about a
  notes location, and never create a notes directory somewhere else.
- **Arguments.** When the user types `/deskbook <args>`, run the tool with those
  arguments. With none, run `index`.
- **`serve` runs until stopped.** Start it in the background and give the user
  the URL. Never wait on it.
- **After `index`,** report the counts and offer to publish `dashboard.html` as
  an artifact.
- **After `cleanup` with no `--apply`,** show what would happen and ask first.
  Never pass `--apply` or `--purge` unless the user asked for it.
- **`where`** answers "where do my notes live", in any repository, with or
  without a notebook. The path is the only thing on stdout.
- **`new` indexes afterwards,** so do not follow it with `index`.
- **A refusal means "not set up yet", never "broken".** Every command except
  `init`, `where` and `shim` refuses in a repository with no `RULES.md`, and
  writes nothing there.

## Resuming or handing over

When the user wants to pick work back up, or pass it to a cloud session or a
colleague, run `brief`. It emits one self-contained block — status, links,
branches with PR state, and every note in the item — so a session that cannot
read this disk still gets the full picture. `--short` gives an outline instead.

## Worktrees

`index` records every git worktree of the repository with its branch and
pull-request state, and attaches the matching ones to each item. Matching uses
the item's `id` and slug; an umbrella item whose children use other keys lists
them in `branches:`.

Run `index` after you add or change a work item, so `INDEX.md` stays true.

## Cleanup

Mechanical, so it needs no judgement:

| Trigger | Action |
| -- | -- |
| `status: done` for 14 days | move the item to `archive/` |
| anything in `run/` older than 7 days | delete |
| worktree under `.claude/worktrees/` whose PR is merged | remove |
| anything in `run/.trash/` older than 7 days | delete |

`cleanup` prints and changes nothing without `--apply`. Never pass `--apply`
unless the user asked for it. Worktrees outside `.claude/worktrees/` are never
touched.

## The dashboard

`index` writes `dashboard.html` at the notes root: every item grouped by status,
with the markdown rendered inline. It is self-contained, so publish it with the
Artifact tool and hand the user the link, or open the file directly.

**`serve` is the working view; the artifact is a share view.** A hosted page
cannot reach the filesystem, so its buttons copy a path or a command. Locally,
Folder, Terminal, Claude session, worktree removal and delete all run for real.

When the user asks to open a project, a folder or a new session, or to remove a
worktree, run `serve --open` and tell them the actions are on the page. The
Claude + context button starts a session in the worktree with a prompt naming
the project and its notes path. For a single removal from the command line, use
`deskbook worktree rm <branch>` — it deletes the directory and leaves the branch
and its commits intact.
