---
name: evidence
description: >-
  The evidence store contract: where verification evidence (screenshots, before/after
  pairs, command output, error text, HTTP responses) is saved, the entry format, and the
  freshness rule. Use when any verification, exercise, test run, or debugging session
  should leave proof a PR reviewer can see, or when composing a PR's Testing Plan from
  that proof.
metadata:
  group: quality
---

# Evidence store

Verification that leaves no evidence gets done twice: once by the agent, once more by
the reviewer who cannot see what the agent saw. The **evidence store** is where every
capture lands so that `create-pr` can put it in the PR's Testing Plan. A capture skill
writes to the store; `create-pr` reads it and publishes. This file is the contract both
sides share.

## Where it lives

```
$XDG_STATE_HOME/evidence/{project}/{change_key}/
  files/            screenshots (.png), output excerpts (.txt), responses (.json)
  entries/{id}.json one evidence entry per file set
```

Fall back to `~/.local/state/evidence/...`, then `~/.evidence/...`. Never inside the
repository, because captures would land in the diff under review; never in `/tmp`,
because a reboot between verification and PR creation would destroy the proof.

- `project` — the base repository as `owner-repo`: the `upstream` remote when one is
  configured, otherwise `origin`. A fork and its parent then share one store.
- `change_key` — the current branch name with `/` replaced by `--`
  (`feature/pr-evidence` → `feature--pr-evidence`).

Any skill can work the path out from the checkout, so nothing has to be passed around.
A caller that runs a skill in another checkout (a merge-base worktree, a sub-agent's
worktree) passes `--evidence-dir=<path>` instead, and that path wins. With no branch
(detached HEAD) and no `--evidence-dir`, there is no store: capture into a temporary
directory, report the files by path, and write no entries.

Directory mode 0700, files 0600. When creating a store, prune `{change_key}` directories
whose newest entry is older than 30 days.

## Entries

One JSON file per entry, written once and never edited. Skills running in parallel
each write their own files, so there is no shared manifest to race on. Name it
`{capturer}-{UTC yyyymmddThhmmss}-{4 random hex}.json`, and create it exclusively: if
the name exists, draw a new suffix.

```json
{
  "id": "exerciser-20261107T141502-a3f9",
  "claim": "Saving a record keeps it after a page reload",
  "kind": "screenshot",
  "files": ["files/record-saved-1440-a3f9-after.png"],
  "before": "files/record-saved-1440-a3f9-before.png",
  "command": "playwright: /records/42 → click Save → reload",
  "headSha": "<full SHA the capture ran against>",
  "dirty": false,
  "result": "pass"
}
```

- `claim` — the behavior this proves, worded as a Testing Plan check a human could run.
  It is the join key `create-pr` matches on. When a caller hands over an exact check
  list, copy each check's wording verbatim; otherwise write the user-visible behavior,
  not the internal step.
- `kind` — `screenshot` | `output` | `log` | `http`.
- `files` — paths relative to the store.
- `before` — the matching capture from before the change, or `"new-feature"` when there
  was nothing to capture, or `null` when the kind has no meaningful before (a test-suite
  count).
- `command` — what produced it, exact enough to re-run.
- `dirty` — `true` when the working tree had uncommitted changes during the capture.
- `result` — `pass` | `fail` | `observed` (captured without a pass/fail judgement).

## Capturing

**Screenshots** are named `{slug}-{width}-{suffix}-{before|after}.png`, where `{suffix}`
is the entry's random suffix, so a later round never overwrites a file an older entry
points at. Capture full-page at the viewports the change affects.

**Output** is an excerpt: the command line, the summary counts, the failing assertion
with its stack frame, the response body. Ten meaningful lines beat a ten-thousand-line
log a reviewer will never open. Keep the full log beside it as a second file only when
the excerpt cannot stand alone.

**Before captures** are the default whenever the change alters something that existed at
the merge base: a reviewer judges a change by comparing it. Capture the same view or
command against the merge base in a scratch worktree
(`git worktree add --detach <tmp> <merge-base>`), with `--evidence-dir` pointing at this
store. Run the two instances one at a time: stop the current app, start the merge-base
one, capture, stop it, and restart the current one. Two copies of one app collide on
ports and share database state. Record `before: "new-feature"` when the thing did not
exist at the merge base, and say so in the claim. When there is no merge base (a
non-branch scope) or the before instance cannot be run, record `before: null` and state
why in the entry's `command`.

Write the entry only after its files exist, so an entry never points at a missing file.

## Freshness

An entry is **fresh** when its `headSha` equals the head the PR shows and `dirty` is
`false`. Anything else proved something about code that is not what the PR contains. It
is a hint for what to capture again, not proof. `create-pr` presents only fresh entries
as verified.

## Returning to a caller

Capture skills report entry ids, not file contents. The caller's context stays lean,
and the proof is still on disk for `create-pr` to read.

## Publishing

`create-pr` publishes. It reads the fresh entries, uploads their files through its
forge binding's `attach` operation, and embeds them in the Testing Plan. A capture skill
never uploads anything itself.
