# The run ledger

The coach's convergence machinery — what was found, what was decided about it, what
the player was told, what came back — used to live only in the coach's own context.
Every rule that depended on it was really a rule about recall: *compare this finding
against the previous ones* only works if the previous ones are still in view.

They are not always still in view. A long run compacts, and a summariser keeps the
top few items of a report it saw thousands of tokens ago. The coach then passes on
everything it can still see, which is a fraction of what it was told to pass on, and
it does so without any sense that something is missing. Rounds stop converging: the
same problems get re-found under new names, and the feedback set shrinks to whatever
survived the squeeze.

The ledger is the fix, and the fix is not the file — it is the habit of reading the
file. A ledger that exists but is recalled rather than re-read buys nothing.

## Where it lives

```
$XDG_STATE_HOME/player-coach/{project}/{change_key}/
  ledger.json            the run ledger
  feedback/turn-{n}.md   the rendered feedback set handed to each player turn
  reports/{n}.json       the verify JSON report for each verification run
```

Fall back to `~/.local/state/player-coach/...`, then `~/.player-coach/...`. This
mirrors `epic-runner`'s state convention, and for the same two reasons: never inside
the repository, because a long run would litter the diff under review; never in
`/tmp`, because a reboot mid-run would destroy the record of everything decided so
far.

- `project` — the canonical base repository slug resolved while preparing the target.
- `change_key` — the feature branch name, slugified. A default run chooses the branch
  before its first commit, and a `--resume-ci` run learns it from the inspected change and
  checks it out before any ledger read, so the key is available and stable on both entry
  paths — after branch resolution, never before it.

Record `prUrl` in the ledger once it exists, but never key on it: at turn 1 there is
no PR.

**The ledger is written under `--no-pr` too.** That mode publishes nothing at all, so
without the local record a local-only run would have no memory whatsoever.

Directory mode 0700, files 0600. Single writer: the coach. Write by creating
`ledger.json.tmp` in the same directory, flushing it, and renaming over the target, so
a crash never leaves a half-written ledger.

Keep the directory after the run — it is the friction record the epic report wants. The
`evidence` store is a separate directory and is likewise kept.
Prune directories untouched for 30 days at startup.

## The epic quarantine file

A ledger is per-change, and that is right for findings: identity is defined by path and
defect mechanism against one diff, so merging ledgers across branches would make `matchedTo`
meaningless. Quarantine entries are the exception. They record something proved about the
*environment* — a suite that was already broken at the merge base and that the change never
touches — and that proof does not stop being true when the next issue starts.

`--epic-quarantine=<path>` names a file holding an array of quarantine entries in exactly the
schema below, shared by every run in one epic:

- **Seed** the ledger's `quarantine` array from it at Phase 0, then apply the closing rule to
  each seeded entry against *this* run's merge base and diff. An entry whose paths now appear
  in the diff, or whose merge base has moved, is invalidated and re-diagnosed once — inherited
  evidence is still evidence about a specific state of the world.
- **Append** when this run opens an entry, and mirror `active: false` when it invalidates one.
- Writes are serialised by the orchestrator, which runs one implementation at a time, so
  there is no concurrent writer to reconcile.

Without the flag, quarantine behaves exactly as it always has and lives only in the ledger.

## The ledger is the only memory

Nothing the coach decides is published anywhere else. The PR carries commits, state, and a
final description written for a human; none of that records which findings were deferred,
which suite was quarantined, or how many turns a run has spent. The ledger is authoritative
unconditionally, in every mode.

A missing ledger is therefore a real loss, not a recoverable one: a resume on another
machine, or after the retention window, starts with empty history and fresh counters and
re-verifies the observed head. That is the honest outcome — re-verifying costs one run,
while reconstructing decisions from a PR body would be inventing them.

## Schema

```json
{
  "schemaVersion": 1,
  "runNumber": "<the run's unique numeric UTC identifier>",
  "project": "owner/repo",
  "changeKey": "feat-3202-eager-init",
  "planFile": "/abs/path/plan.md",
  "severityThreshold": 5,
  "maxTurns": 10,
  "baseRef": "origin/main",
  "mergeBase": "<full sha>",
  "prUrl": null,
  "createdAt": "2026-08-09T12:00:00Z",
  "updatedAt": "2026-08-09T12:41:00Z",

  "turns": [
    {
      "turn": 1,
      "headSha": "<full sha>",
      "noop": false,
      "changedPaths": ["src/redis/client.ts"],
      "build": "pass",
      "tests": "42 passed, 0 failed",
      "app": "started",
      "concerns": ["the retry budget is a guess"],
      "feedbackFile": null,
      "feedbackItemsGiven": [],
      "feedbackItemsAddressed": []
    }
  ],

  "verificationRuns": [
    {
      "verifyRun": 1,
      "turn": 1,
      "headSha": "<full sha>",
      "reportPath": "reports/1.json",
      "deltaBaseSha": null,
      "fullAudit": true,
      "status": "ok",
      "decision": "FEEDBACK",
      "gates": {"exerciser": "PASSED", "judgementReviewer": "reviewer (Codex unavailable)", "customGates": "PASS"},
      "findingIds": ["F-1", "F-2"]
    }
  ],

  "findings": [
    {
      "id": "F-1",
      "key": "src/redis/client.ts::rejected-lazy-init-leaves-client-orphaned",
      "location": {"path": "src/redis/client.ts", "line": 27, "endLine": 41},
      "title": "A rejected lazy init leaves the client orphaned",
      "rootCause": "The rejected promise stays cached, so every later caller awaits a dead client.",
      "class": "correctness",
      "severity": 8,
      "severityHistory": [8, 8, 6],
      "sources": ["reviewer", "codex-reviewer"],
      "firstSeen": {"verifyRun": 1, "turn": 1, "headSha": "<full sha>"},
      "lastSeen": {"verifyRun": 3, "turn": 3, "headSha": "<full sha>"},
      "occurrences": 3,
      "disposition": "open",
      "dispositionReason": "still reproducible at the current head",
      "dispositionSetAt": {"verifyRun": 3, "turn": 3},
      "evidence": "reviewer quoted the cached rejection at line 34",
      "matchedTo": null,
      "matchReason": null,
      "reaffirmedBy": [{"verifyRun": 4, "skill": "codex-reviewer", "reason": "unchanged since delta base", "newHarmEvidence": false}],
      "followUp": {"kind": "none", "ref": null}
    }
  ],

  "quarantine": [
    {
      "id": "Q-1",
      "title": "Keycloak port mismatch fails the full backend suite",
      "signature": "ECONNREFUSED 127.0.0.1:8080 in test/setup/auth.ts",
      "paths": ["test/setup/auth.ts"],
      "diagnosis": "The stack is configured on 13000/13032; the suite reads 16200/16232.",
      "provenance": {
        "reproducedAt": "<merge base sha>",
        "command": "npm run test:backend",
        "outputExcerpt": "ECONNREFUSED 127.0.0.1:8080"
      },
      "firstSeen": {"verifyRun": 3, "turn": 3},
      "reraiseCount": 0,
      "active": true,
      "invalidatedBy": null
    }
  ],

  "ciFailures": [
    {"ciRun": 1, "turn": 5, "headSha": "<full sha>", "check": "backend", "summary": "…", "quarantineId": null}
  ],

  "policy": {"coverageCapFromRound": 3},
  "carryForward": {"lastVerifiedHeadSha": "<full sha>", "lastFullAuditSha": "<full sha>", "lastVerifiedThreshold": 5}
}
```

### `disposition`

`open` · `fixed` · `accepted-below-threshold` · `deferred-out-of-scope` · `quarantined`

**Stickiness is derived, not stored**: a finding is sticky when `occurrences > 1` and
`disposition` is `open`. Making it a sixth enum value would let a finding be both
sticky and fixed, which means nothing.

### `fullAudit`

*How much of the diff the reviewers reviewed* — false when the run was delta-scoped by
`--since`, true when they saw the whole change.

### `class`

`correctness` · `security` · `coverage` · `comment` · `ux` · `visual` ·
`test-failure` · `environment` · `style` · `plan-completeness`

The coverage rules and the quarantine rules both key on this, so the boundary between
`coverage` and `correctness` has to be sharp. Skills emit `class` as a hint; verify
assigns the final value during dedup.

### Finding identity

Two findings are the same finding when:

1. the normalised `location.path` is equal — **path equality is mandatory, never
   merge across files** — and
2. either the stated root cause describes the same defect mechanism, or both name the
   same symbol and the same symptom.

Line ranges drift as the diff grows and are not part of identity.

Record `matchedTo` and `matchReason` whenever a match is made. A wrong merge hides a
finding and a wrong split preserves the drift; neither is preventable in general, so
the decision is written down where a human can audit it afterwards.

## Write protocol

| When | What is written |
|---|---|
| Phase 0, initialising state | create, or reopen the existing file on resume; record run number, threshold, base, plan; seed `quarantine` from `--epic-quarantine` |
| Phase 1 step 1, after the player returns | the turn record, including `feedbackItemsAddressed` from the player's receipt table |
| Phase 1 step 3, as soon as the report is read | the verification-run record with `decision` and `gates` still null, *before* gates — so a crash mid-gate is recoverable |
| Phase 1 step 4, after reconciliation | findings, dispositions, quarantine updates, coverage decisions |
| Phase 1 step 5, once the decision is made | that run's `decision` and `gates`, and `carryForward` on an approving run |
| Phase 3 | CI failures; a failed Testing Plan check as an ordinary finding |
| Phase 4 | the terminal status |

## Read protocol

Re-read `ledger.json` in full before deciding gates, before rendering a feedback file,
and before composing any player prompt.

Not "consult your memory of it" — read the file. The whole point is that the coach's
memory of round 2 is exactly what a long run takes away, and the file is what remains
when it does.
