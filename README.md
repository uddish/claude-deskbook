# Deskbook

A place for work notes that does not grow into a mess.

Notes tend to rot in a predictable way: a directory per task, three versions of
the same plan, tools stranded beside the work they serve, and API keys sitting
next to documents you meant to keep. Deskbook fixes the layout, generates the
index, and makes cleanup mechanical.

## What it gives you

- **One predictable root**, per project, resolved from the working directory.
- **Opt-in per repository.** Nothing is created until you run `init`, so the
  plugin does not add a notes directory to every repository you open.
- **A file per task**, and a directory only when a second file has to exist.
- **`INDEX.md`**, generated from front matter — never hand-maintained.
- **A dashboard**, one self-contained HTML page showing every note rendered.
- **Cleanup with no judgement calls**: finished work archives itself,
  disposable files expire, merged worktrees go.
- **Worktrees on the page**, with branch and pull-request state, so you can see
  which checkouts are finished with.
- **Works with any tracker.** Links are plain URLs; the label comes from the
  host. Jira, GitHub, Notion, Shortcut, ClickUp and the rest need no setup.

## Install

```bash
git clone https://github.com/uddish/claude-deskbook
claude
> /plugin marketplace add ./claude-deskbook
> /plugin install deskbook
```

## 60-second start

```
/deskbook init          # opt this repository in, and print where notes live
/deskbook adopt         # find notes you already have; pick which to bring in
/deskbook new my-task   # a task file, with front matter filled in
/deskbook serve --open  # the dashboard, with every action live
```

**Nothing happens until `init`.** In a repository you have not opted in, every
other command refuses and writes nothing at all.

Lost the path a week later? `/deskbook where` prints it, in any repository, with
or without a notebook. The path is the only thing on stdout, so this works:

```bash
cd "$(deskbook where)"
```

## Two ways to run it

Inside Claude Code the plugin gives you a slash command:

```
/deskbook init
/deskbook serve --open
```

For a terminal, install a `deskbook` command on your PATH once:

```
/deskbook shim              # writes ~/.local/bin/deskbook
export PATH="$HOME/.local/bin:$PATH"
```

After that the bare `deskbook …` form used throughout this README works. Without
the shim it does not exist — the plugin only registers the slash command.

Then, in any repository:

```
/deskbook init      # create the layout, print where it lives
/deskbook adopt     # find notes you already have, and pick which to bring in
/deskbook index     # write INDEX.md and dashboard.html
```

`adopt` is the part that matters on day one. It looks for markdown that reads
like working notes — anything git is not tracking, anything already beside this
project's Claude files, and committed files named `plan`, `design`, `rfc` and
the like — then **asks which ones you want**. Nothing is adopted without you
choosing it, and files are copied, never moved.

## Two ways to view it

**`deskbook serve` is the one to use day to day.** It runs the dashboard from
`127.0.0.1`, where the buttons actually do things:

| Action | What happens |
| -- | -- |
| Folder | reveals the directory, or the note file, in your file manager |
| Claude + context | opens a terminal in the worktree and runs `claude`, already told which project it is and where the notes are |
| remove | `git worktree remove` — the directory goes, the branch stays |
| remove N merged | removes every agent worktree whose pull request has merged |
| delete | moves the item to `run/.trash` |

```
deskbook serve          # http://127.0.0.1:4478
deskbook serve --open   # and open a browser
```

**The published artifact is a read-only share view.** A hosted page cannot reach
your filesystem: the content policy blocks it, the sandbox blocks downloads, and
`file://` is unreachable from `https`. So on that page the same controls copy a
path or a command instead of running it. Use it to share a plan; use `serve` to
work.

Every mutating route needs an `X-Deskbook` header, which a cross-site request
cannot set without a preflight it will fail, and every path is checked against a
set the server builds itself from `git worktree list`.

## What happens when a session starts

In a repository where you ran `init`, every new Claude Code session begins with
a short block — the notes path, up to five active items, and the counts:

```
Deskbook: /Users/you/.claude/projects/-Users-you-repo/notes
Active:
  API-85   Executions schema-first migration   work/api-85-executions/  2026-09-04
  API-207  Migrate the retry endpoint          work/api-207-retry.md    2026-09-02
2 parked, 7 archived. Rules: RULES.md
```

So Claude knows where notes live before you say anything, and a plan you ask
for lands in `work/` instead of a directory it invents.

**It reads and prints. It writes nothing.** In a repository where you never ran
`init` it prints nothing and exits 0, so it is silent everywhere you did not opt
in. It takes about 20 ms. The hook is `hooks/hooks.json`; the command it runs is
`deskbook session`, which you can run by hand.

## Where notes go

1. `$DESKBOOK_HOME` if set
2. otherwise `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/<cwd-as-slug>/notes`

So each repository gets its own notebook, in the place Claude Code already
keeps that project's files. A repository has none until you run `init` in it.

### Why aren't my notes in my repository?

Because notes are personal, and a repository is shared. Working notes name
customers, unreleased work, and opinions you have not finished forming. A
default inside the repository puts all of that one `git add` away from a public
branch. Outside it, that mistake cannot happen.

If you want them in the repository anyway, ask for it:

```bash
export DESKBOOK_HOME="$PWD/notes"
```

Then commit the directory. Two consequences to accept first: the notes are now
as public as the repository, and everyone who clones it gets them.

Use an absolute path, as above. A relative `./notes` also works, but it resolves
from the directory you run the command in, so it finds nothing from a
subdirectory.

## Layout

```
notes/
  INDEX.md      generated
  RULES.md      the conventions, installed by `deskbook init`
  dashboard.html
  work/         live work
  reference/    durable docs and shared tools
  archive/      finished work
  run/          disposable
```

## Commands

| Command | Does |
| -- | -- |
| `deskbook shim [dir]` | install a `deskbook` command on your PATH |
| `deskbook init` | create the layout and install `RULES.md` |
| `deskbook where` | print the notes root; works before `init` too |
| `deskbook session` | what the session-start hook runs: the root, active items, counts. Read-only |
| `deskbook index` | rewrite `INDEX.md` and `dashboard.html` |
| `deskbook new <slug>` | create a task file with front matter |
| `deskbook adopt [--all]` | find existing notes; `--take a.md,b.md` brings them in |
| `deskbook brief <slug> [--short]` | print a paste-ready context block |
| `deskbook rm <slug>` | move an item to `run/.trash` (`--purge` skips it) |
| `deskbook worktree rm <branch>` | remove a worktree; the branch survives |
| `deskbook serve [port] [--open]` | local dashboard where every action works |
| `deskbook cleanup` | show what cleanup would do |
| `deskbook cleanup --apply` | do it |

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

## Deleting things

`deskbook rm <slug>` moves an item to `run/.trash/`, and cleanup purges it
after 7 days, so a wrong click costs nothing for a week. `--purge` removes it
immediately.

The dashboard you publish as an artifact is a static page — it cannot touch
your disk, so its button copies the command for you. `deskbook serve` runs the
same page from `127.0.0.1`, where the delete button deletes for real. That
endpoint requires an `X-Deskbook` header, so another website cannot post to it.

## Requirements

Node 18 or later. No dependencies. Run `node bin/selftest.mjs` to exercise every
command in a throwaway repository.

`git` and `gh` are optional. They are used to list worktrees and to spot ones
whose pull request has merged; without them the worktree panel is simply
empty.
