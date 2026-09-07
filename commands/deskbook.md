---
description: Organise work notes — index, create, brief, adopt, clean up, or open the dashboard
argument-hint: "[index | serve | new <slug> | brief <slug> | adopt | where | rm <slug> | worktree rm <branch> | cleanup | init | shim]"
allowed-tools: Bash(node:*), Bash(git:*), Bash(gh:*), Read
---

Run the deskbook tool with the arguments given: `$ARGUMENTS` (default `index`).

The script is at `${CLAUDE_PLUGIN_ROOT}/bin/deskbook.mjs`. Run it with `node`
from the current working directory, so it resolves the right notes root.

Notes:

- After `index`, report the counts and offer to publish `dashboard.html` as an
  artifact.
- `serve` runs until stopped, so start it in the background and give the user
  the URL. It is the only place the folder, Claude-session and worktree-removal
  actions work; a published artifact cannot reach the filesystem.
- After `cleanup` without `--apply`, show what would happen and ask first.
  Never pass `--apply` or `--purge` unless the user asked for it.
- If the notes root has no `RULES.md`, this repository is not set up yet: run
  `init`, then `adopt --json`, then ask which files to bring in. Every command
  except `init`, `where` and `shim` refuses until then, and writes nothing.
- `where` prints the notes root and nothing else on stdout. Use it when the user
  asks where their notes live, in any repository.
- `new` indexes afterwards, so do not run `index` again straight after it.
