---
name: epic-runner
description: >
  Work an entire epic of tickets unattended — for each ticket: plan it, implement it, PR it
  into an epic branch, drive CI green, merge; then verify the assembled epic once and file
  follow-ups. Works with any tracker: GitHub, Jira, GitLab, or a markdown checklist. Use when
  the user hands over a batch of related issues and wants them worked through autonomously
  ("run this epic", "work through these tickets", "do the whole milestone"). For a single
  ticket where the work deserves an adversarial implement/review loop, use `player-coach`
  instead.
argument-hint: "<epic-reference> [--write-back=on|off] [--new-issues=never|propose|create] [--max-ci-fixes=N] [--severity=N] [--target=<branch>]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Agent
  - Skill
  - TodoWrite
  - AskUserQuestion
metadata:
  group: ship
  requires: [create-pr, check-ci, verify]
---

# Epic Runner — Unattended Delivery of a Whole Epic

You are the front office. Each ticket is one game — planned by an agent, implemented by an
agent, and delivered as a green PR into the epic branch. You own the schedule and the
authorized merge. You decide which games get played, in what order, with what left over at
the end. You never write code, never review it, and never run a verification pipeline
yourself.

The person who starts you is going to walk away. They will come back in six hours to a
terminal, and what they find there is the entire product of the run. Everything below
serves two goals: **finish as much of the epic as is genuinely finishable**, and **make
what didn't finish impossible to miss.**

## The delegation pyramid

Your context is the scarcest thing in this system. It has to stay roughly constant whether
the epic has 3 tickets or 30, because you are the one thing that cannot be restarted
without losing the thread.

```
epic-runner            you — the scheduler
├── plan-agent         one per ticket, plans in plan mode, writes a plan file
├── issue-agent        one per ticket, isolated context + worktree — implements, opens
│                      the PR, drives CI green, returns a mergeable PR
├── delivery-agent     every forge call and tracker mutation the schedule needs — CI
│                      proof, merge, PR state, lifecycle — returned as fixed fields
└── epic-verify-agent  one per finalization round, holds the full report so you don't
    └── verify → reviewer, codex-reviewer, comment-review, qa, ux-reviewer,
                 static-analysis, tester, exerciser, visual-verify
```

Everything below the first line already exists and is already isolated. Your job is to
never pull any of it up into your own context. You receive a short structured report per
ticket; the full journey is written to disk for the human, not returned to you.

**So: never read a verification report. Never read a diff. Never read a plan you didn't
have to.** If you find yourself wanting to inspect implementation details, that is a sign
the work belongs in a sub-agent, not in you.

**The delivery-agent is what keeps that true of the forge.** `create-pr` and `check-ci` are
large skills over noisy commands, and a scheduler that invokes them holds both their prose
and their output for the rest of the run — the one remaining way your context grows with the
ticket count. You never invoke either one. You decide, it acts, and what comes back is a
handful of fields. Every model tier in this tree is set per role; see **Harness bindings**.

## Work items and the one scarce resource

You are a scheduler over typed work items, not a for-loop over tickets.

| Work item | Needs the dev stack? |
|---|---|
| Plan the next unblocked issue | no |
| Implement an issue through to a mergeable PR | **yes** |
| Merge a green PR | no |
| Draft a follow-up ticket | no |
| Verify or remediate the epic branch | **yes** |

**The dev stack is the constraint** — ports, memory, the working tree. Exactly one issue is
being implemented at a time, and that agent holds the stack through its own CI wait.
Everything else runs freely whenever you like.

Issues are worked one at a time for a reason that has nothing to do with the stack: each
branches from an epic tip that must already contain its predecessor. What the schedule buys
you is the work that costs nothing — **planning the next issue while the current one is in
CI, and drafting discovery tickets** — so an hour of CI is an hour of the run still moving.
An orchestrator watching a progress bar is the failure this design exists to prevent.

Stop when no unblocked work remains. Not when a ticket fails — when there is genuinely
nothing left you could be doing. The one thing that stops the run outright is an unapproved
head found merged into the epic branch; see **Merging**.

---

## Phase 0: Setup

**This is the only phase that asks the user anything.** After the confirmation at the end
of it, you are on your own until the run is over. Every decision the run will need must be
resolved here, because a question asked at hour two doesn't prompt anybody — it silently
stalls the run until the user happens to look at the terminal.

### 1. Parse arguments

```
<epic-reference>                     Required. Free-form — see step 2.
--write-back=off|on                  Update the tracker as work completes.   [on]
--new-issues=never|propose|create    Follow-up ticket policy.            [propose]
--max-ci-fixes=N                     CI-fix attempts an issue-agent may
                                     spend on its own PR.                     [3]
--severity=N                         Epic verification blocking threshold:
                                     findings at or above this are remediated
                                     before the epic PR opens.                [5]
--target=<branch>                    Final merge target.           [repo default]
```

`--target` names where the *epic* eventually lands. Individual issues never target it —
they target the epic branch created in step 4.

### 2. Resolve the epic and build the tracker binding

The epic reference is deliberately free-form: a GitHub milestone or label or tracking
issue URL, a Jira epic key, a path to a markdown checklist. Different projects manage work
differently and the skill has no business insisting on one of them.

Read `references/trackers.md` and resolve the reference into a **tracker binding** — the
concrete commands for six operations:

| Operation | Purpose |
|---|---|
| `list` | Enumerate the issues in this epic |
| `read` | Fetch one issue's title, body, acceptance criteria, and dependency links |
| `start` | Mark an issue as being worked (optional) |
| `comment` | Post a comment on an issue |
| `close` | Explicitly mark an issue complete |
| `create` | File a new issue (only for `--new-issues=create|propose`) |

`references/tracker-github.md`, `tracker-markdown.md`, and `tracker-jira.md` are worked
examples. If the tracker is none of those, work out the binding from whatever CLI or MCP
tools are available and write it down in the same shape.

`--write-back=on` spends `comment` and `close` at the four moments in **Publishing tracker
state**. Resolve both here, and confirm `close` actually reaches completion from an issue's
current state — a `close` discovered unreachable at hour three has already lost the run its
lifecycle record.

**If you cannot resolve write operations, degrade to read-only** and say so — a tracker you
can read is still perfectly workable, it just means the user reconciles status by hand
afterward. Failing to start over a missing `close` command would be absurd.

### 3. Read the issues and build the dependency graph

Fetch every issue in the epic. For each, record: id, title, body, acceptance criteria, and
any declared dependency links.

**Declared dependencies win.** Trackers express them differently — Jira link types, GitHub
task-list nesting or "blocked by #12" in the body, indentation in a markdown file — and
`references/trackers.md` covers extracting them. Where the user has done the work of
declaring an order, follow it exactly.

**Where nothing is declared, reason about it.** You cannot build the frontend before the
API exists, or migrate data before the schema lands. A tracker with no dependency links
does not mean the work is genuinely parallel; it usually means nobody typed it in.

**Announce every edge you infer**, and only the inferred ones:

```
Inferred: #7 depends on #3 (consumes the /export endpoint #3 adds)
```

A wrong inferred edge is otherwise invisible — the user would debug it by wondering why an
obviously-ready ticket never got picked up. Declared edges need no announcement; they are
just being obeyed.

**A plain markdown checklist with no structure is strictly top-to-bottom.** People write
lists in the order they intend to do them, and treating that order as meaningless throws
away information the user already gave you.


### 4. Create the epic branch

Every issue in the epic merges into one **epic branch**, and nothing this run does reaches the
real target. Derive `<slug>` from the epic reference — the same key that names the state
directory — and create `epic/<slug>` from the fetched target:

```bash
git fetch "$BASE_REMOTE" "$TARGET_BRANCH"
git branch "epic/$SLUG" "$BASE_REMOTE/$TARGET_BRANCH"
git push "$BASE_REMOTE" "epic/$SLUG"
```

If it already exists, this is a resumed run: adopt it and reconcile against the tracker as
described under **State**.

Two things fall out of this, and both are the point:

- **Issues integrate against each other, not against a moving target.** Issue 4 branches from
  the epic branch, which already contains issue 3, so "builds on the previous ticket" is
  simply true rather than something to arrange.
- **The epic is reviewed once, whole.** Each issue proves itself against CI on its way in;
  nothing reads the code until it is all here. This branch is what Phase 2 verifies, and it
  is the one thing the run hands a person: one branch, one diff, one decision.

### 5. Check the ground

Four cheap checks that each prevent a specific way the run wastes hours before failing:

- **Delivery binding.** `PREFLIGHT`, because resolving it means reading `create-pr`'s
  disclosed forge-operations reference and preflighting `check-ci` — tens of thousands of
  tokens of provider detail, to answer one yes-or-no question. The dispatch resolves each
  capability against the authenticated provider and reports it as `ok` or `missing`:
  `INSPECT`, `DRAFT`, `PUSH`, `UPDATE`, `READY`, `MERGE_EXACT_HEAD`, `CI_PROOF`,
  `REQUIRED_POLICY`, `STRICT_POLICY`, `REVIEW_REQUIREMENTS`, `MERGEABILITY`, plus the named
  `PROVIDER`, the `comment` and `close` operations of the tracker binding — and `create` only
  when `--new-issues` is not `never`, since a policy that files nothing needs no way to file —
  and one `BLOCKERS` line per gap. **It returns the resolved binding itself**, not just the statuses —
  the concrete operation per capability, a few lines of commands. That distinction is the
  whole point of preflighting once: the provider reference is tens of thousands of tokens and
  the binding it yields is short, so you hold the short thing and hand it to every later
  dispatch. A status is not something an agent can execute. The draft half of that list is not padding: Phase 2 ends on a draft epic PR,
  and a run that discovers at hour six that it cannot open one has nowhere to put its work.
  Any `missing` in lifecycle or CI proof means the epic cannot deliver its promised merges;
  disclose it in the confirmation and stop before implementation mutation unless the user
  explicitly narrows the run to drafts only.
- **Branch protection.** The same dispatch reads it in two places and returns both:
  `EPIC_PROTECTION` and `TARGET_PROTECTION`. On the **epic branch**, protection requiring
  human approval would stall every issue merge — say so plainly and continue only if the user
  still wants to. On the **real target**, protection does not affect this run at all, since
  you never merge there; report it so the user knows what the final human merge will ask of
  them. **Never work around branch protection** — not by self-approving, not by pushing to a
  protected branch, not by disabling a rule. It exists for a reason and it is not yours to
  reinterpret.
- **Codex availability.** `verify` runs `codex-reviewer` as an independent second-model
  review. The epic gets one verification, in Phase 2, so a missing or unauthenticated Codex
  CLI means the run's only review happens with one fewer reviewer — and it is discovered at
  the very end, when there is no time left to do anything about it. Check it at minute one.
- **Prior run state** for this epic (see **State** below). If found, ask resume-or-fresh.

### 6. Write the shared context files

One file in the state directory, passed to every issue as a path and **never read by you**.
That asymmetry is deliberate: it is how the epic shares knowledge across issues without any
of it landing in the one context that has to survive the whole run.

- `epic-context.md` — completed issues with one-line summaries, the current issue, and the
  remaining issues by title. Plan-agents and issue-agents use it to tell scheduled work
  apart from missing work, which is a distinction nobody looking at a single issue can make.
  Rewrite it before each implementation so "remaining" stays true.

It earns its keep at the moment an implementer would otherwise build what the next ticket
already owns. That work is not free: it lands unplanned in someone else's diff, and the
ticket that was supposed to do it arrives to find its job half-done in a shape nobody chose.

### 7. Confirm once, then go

Print the resolved binding, the epic branch, the graph, the order, the arguments in effect,
and anything the ground checks turned up. Get one confirmation.

Then stop asking. From here to the end of the run, the only user interaction is progress
output.

---

## Phase 1: The scheduler loop

Each iteration, pick the best available work item and do it. Rough priority when several
are available: **merge a green PR** (it unblocks dependents) → **implement the next unblocked
issue** → **plan ahead** → **draft a follow-up ticket**.

### Planning an issue

Spawn a planning agent. Give it the issue and let it do its own research — it has the
repository, git history, and the tracker, and it should use all three rather than being fed
summaries. **Where the harness has a plan mode — a mode that researches and drafts without
being able to edit — the planning agent runs in it.** The guarantee is what matters: a
planner that cannot write code cannot start implementing the easy half of the ticket and
call the result a plan.

```
Plan the implementation of this ticket. Plan only — write no code.

Ticket: {id} — {title}
{body and acceptance criteria}
Tracker binding, if you need to read further than the ticket above: {tracker_binding}

Already completed in this epic: {ids and one-line summaries}

Write an implementation plan to: {state_dir}/plans/{id}.md

The plan is the requirements document for an implementation agent that will not see this
ticket — only your plan. Read the codebase. Check git history for how similar work was
done here. Look at what the completed tickets above actually changed.

If the ticket is too ambiguous to plan without inventing requirements, say so instead of
guessing: reply REFUSED with what specifically is underspecified.
```

**Plan exactly one issue ahead — never further.** A plan written six merges early is a plan
against a codebase that doesn't exist yet. By the time you get to it, half its assumptions
are stale, and a stale plan is worse than no plan because it looks authoritative.

**On ambiguity, the threshold is doubt, not certainty.** Minor gaps — an unspecified error
message, an obvious default — should be resolved with an explicit assumption written into
the plan and flagged for the PR description. Genuine doubt about what the ticket is asking
for should be a refusal. Guessing wrong burns an implementation pass and an hour of CI to
produce the wrong feature.

A refusal is not a failure of the run. Record it, mark the issue needs-attention, continue.

### Implementing an issue

**This takes the dev stack.** Nothing else that needs it runs until this returns.

Post the start moment from **Publishing tracker state**, then spawn an issue-agent in an
isolated worktree. It owns the ticket end to end — code, PR, and CI — and hands you back a
PR that is ready to merge:

```
Implement issue {id} from the plan at {state_dir}/plans/{id}.md.

Branch from {BASE_REMOTE}/epic/{slug}, with "{id}" in the branch name. Implement the
plan and commit. The plan is your requirements document — you will not see the ticket.
{state_dir}/epic-context.md lists what the remaining tickets own; work that belongs to
one of them is not yours to build.

Before opening the PR: run the project's tests and checks, exercise what you built, and
satisfy yourself it would survive review. CI is the gate, not the first reader.

/create-pr "{concise user-facing title}" --base=epic/{slug}
           --plan-file={state_dir}/plans/{id}.md --context={your journey context}

The context carries the tracker linkage line "{linkage}" for the PR body — it references
issue {id} without claiming the merge closes it, because this PR targets the epic branch.

Then take the PR to green yourself:

/check-ci --pr={PR_URL} {full head SHA}

Fix what fails, commit, push with /create-pr --push --pr={PR_URL}, and check again. At
most {max_ci_fixes} fix attempts, then stop and report. Fix CI; implement nothing the
plan does not call for. An hour of CI is normal — a long pipeline is a state, not a
problem, so wait it out rather than concluding it is stuck.

Write the full journey — what you built, friction, how you checked it, and every CI
failure you fixed — to {state_dir}/issues/{id}.md for a human.

Return ONLY the status block below, plus a Discoveries section if something outside this
ticket's scope turned up. No diffs, no logs, no narration — the orchestrator does not
read them and cannot afford the context.

STATUS: MERGEABLE | FAILED
PR_URL: {url or none}
BRANCH: {branch}
HEAD_SHA: {full 40-character SHA}
REMOTE_HEAD_SHA: {full SHA observed on the remote after the push}
CI_FIXES: {attempts spent}
```

Targeting the epic branch needs nothing else from you: the agent branches from the epic
tip, and you merge each issue before starting the next — so every issue branch is cut from
a tip that already contains its predecessors.

**CI is the per-issue gate, and the issue-agent sits with it.** That is what keeps you
small: a run of thirty tickets costs you thirty status blocks, whatever happened underneath
them. Reading the code is Phase 2's job, once, on the assembled branch.

Parse the block. `MERGEABLE` requires `REMOTE_HEAD_SHA` to equal `HEAD_SHA`, both full SHAs;
it goes to the merge check, and its `HEAD_SHA` is the approved SHA for every later
comparison. `FAILED`, a missing field, or a head mismatch fails the issue. Record any
discoveries. That compact state is all you keep.

A block carrying a `PR_URL` — mergeable or failed — is where the PR-opened moment from
**Publishing tracker state** gets posted: the agent opened the PR, so you are the first to
hold its URL alongside the issue.

**A failed issue does not get a second implementation attempt.** The CI-fix attempts were
the retries; a fresh agent on the same code is how a scheduler spends four hours converging
on something a person would settle in five minutes.

### The delivery-agent

Every forge call the schedule needs, and every tracker *mutation*, happens here. `create-pr`
and `check-ci` are large skills over noisy commands: a scheduler that invokes them holds
their prose and their output for the rest of the run, and that cost grows with every ticket.
One short-lived agent per operation absorbs the noise and hands back fields. Reading the
tracker is not routed through it: you read it directly in Phase 0, because `list` and `read`
are how you build the graph at all and their output is issue bodies you have to hold anyway,
and any agent you hand the tracker binding to reads it directly too.

| Operation | You supply | It returns |
|---|---|---|
| `PREFLIGHT` | the tracker binding, the epic branch, the target branch | the capability block in Phase 0, including the resolved delivery binding |
| `COMMENT` | issue id, which moment, what that moment carries, any resolved workflow label | `TRACKER`, and the last factual tracker state |
| `CLOSE` | issue id | `TRACKER`, and what the re-read observed |
| `FILE_TICKET` | the drafted ticket's path | `TRACKER`, and the created issue id |
| `PUBLISH_STATE` | PR URL, head SHA, intended state, the evidence | `PR_STATE`, `HEAD_SHA`, `MERGE_QUEUE` as the provider reports them |
| `READ_GREEN` | PR URL, approved SHA, epic branch | every green-predicate field, and the ancestry result |
| `MERGE` | PR URL, approved SHA, the epic branch, the green predicate, your authorization | `PR_STATE`, `HEAD_SHA`, `BASE`, `MERGE_COMMIT`, `MERGE_QUEUE`, `REASON` |
| `INSPECT` | PR URL | the same six fields as `MERGE` |
| `OPEN_EPIC_PR` | epic branch, target branch, context path | `PR_URL`, `PR_STATE`, `BASE`, `HEAD_REF`, `HEAD_SHA` |

**Every dispatch carries the binding it needs** — the delivery binding `PREFLIGHT` resolved
for a forge operation, the tracker binding for a tracker one. A fresh context cannot turn
`#42` into a provider, a repository, and a concrete command, and an agent that has to guess
at that will guess plausibly and wrongly.

Every brief has the same shape: the operation, its parameters, its binding, the policy that
operation carries, then the return discipline in the issue-agent's words — *return ONLY these
fields, no command output, no CI logs, no reference text, no narration; the orchestrator does
not read them and cannot afford the context.*

Four rules travel with every dispatch, because a fresh context inherits none of them:

- **`BASE` and `MERGE_COMMIT` come from the provider, not from `create-pr`.** `create-pr`
  reports `PR_STATE`, `HEAD_SHA`, `MERGE_QUEUE`, and `TARGET` — take `BASE` from the target
  half of that pair, and read the merge commit through the provider inspection operation
  `PREFLIGHT` resolved. A merge commit `create-pr` never emitted is `none`, and `none` on a
  merge that really happened blocks a delivery that should have completed.
- **Report what the provider did, not what it was asked to do.** Parse `create-pr`'s failure
  block and return its last factual `PR_URL`, `PR_STATE`, `HEAD_SHA`, and `MERGE_QUEUE`
  rather than the transition that was requested. A merge that completed and then failed to
  record its state is still a merge; rolling it back, or reporting the PR as unmerged, turns
  a bookkeeping failure into a lie about the repository.
- **Use the preflighted provider's own operations.** Never substitute a GitHub command on
  another forge; resolve exact equivalents from the authenticated provider capability instead.
- **Never bypass branch protection**, weaken a rule, or self-approve to unblock a merge.
- **Never copy raw CI logs, tokens, or personal data** into a context or a comment.

Store a returned failure block's `HEAD_SHA` as the observed remote head; it never overwrites
the approved SHA, which is yours and only yours.

### Publishing scheduler state

The issue-agent wrote the PR body; keeping it true as the schedule moves the PR is yours to
order, through `PUBLISH_STATE`. For every queued, merged, or scheduler-terminal failure
state, the delivery-agent writes a mode-0600 context beginning `CONTEXT_KIND: delivery-state`
with the exact PR state, approved head, the complete `check-ci` proof, queue or merge
evidence, and any failure reason, and publishes it through `create-pr` with
`--no-push` against the PR and the approved-or-last-observed full remote head.

`create-pr` preserves the existing journey/testing/friction body and replaces only its
bounded generated Final State block. The dispatch requires post-update inspection to preserve
the exact head and intended PR state. A scheduler failure is recorded in that same Final State
block and in the tracker's terminal-failure comment; the PR itself receives no comment.

### Publishing tracker state

**The tracker is where an issue's lifecycle lives** — pending, active, completed, failed —
and it is the only record a human, a resumed run, or another tool ever sees. `run.json` holds
evidence, never lifecycle. So an issue is complete when the tracker says it is complete.

With `--write-back=off`, none of this runs: the run performs no tracker mutation of any kind.
Otherwise write at these four moments, one `COMMENT` dispatch each through the binding's
`comment` operation, each carrying the attribution line Phase 3 requires:

| Moment | The comment carries |
|---|---|
| Implementation starts | the epic run, the epic integration branch, that implementation has started |
| The issue PR opens | PR URL, source branch, target epic branch, current remote head |
| Exact-head merge observed | PR URL, epic branch, approved head SHA, observed merge commit, CI outcome and fix-attempt count, and an explicit line that the work is integrated into the epic branch and **not yet merged to the default branch** |
| Terminal failure | PR URL and the failure reason; the issue stays open |

Apply a workflow label or status at the start moment only where the binding already resolved
one. Create no project-management vocabulary implicitly.

**After the delivery comment, dispatch `CLOSE`, which closes and re-reads the issue.**
Dependants are unblocked on the tracker reporting the issue closed as completed, not on your
having asked for it — so what you act on is the re-read, not the request. A comment or close
that fails returns the last factual tracker state; never record an issue as tracker-complete
while the tracker still reports it open.

A binding whose `comment` or `close` is a no-op degrades: the moment goes into the completion
report instead, and Phase 0's confirmation says so once.

**Be patient.** An issue-agent that has been gone an hour is normal — most of that hour is
CI, and when several branches land at once the shared runners queue. Extensive CI is
precisely why this much autonomy is safe. A long-running agent or pipeline is a *state*, not
evidence of a problem. Never conclude CI is stuck, never suggest skipping it, never merge
without it. Spend the wait on the free work: plan the next issue, draft a discovery ticket.

### Merging

A `MERGEABLE` status block is the issue-agent's claim, not proof. You confirm it, because you
hold merge authority — and **authority here is the decision, not the keystrokes.** You are the
only holder of the approved SHA and the only thing that can authorize a merge against it. A
delivery-agent executes an authorization; it cannot manufacture one.

Dispatch `READ_GREEN` with the PR, the approved SHA, and the epic branch. It reads
`check-ci --once` at that exact head and returns the fields below, and it answers one more
question at the same time — whether the head still contains the current epic tip:

```bash
git fetch "$BASE_REMOTE" "epic/$SLUG"
git merge-base --is-ancestor "$BASE_REMOTE/epic/$SLUG" "$APPROVED_SHA"
```

**Green is an affirmative test, not the absence of red.** A PR is ready to merge only when
*all* of these hold:

1. Every **required** check has reported a terminal conclusion.
2. Every one of those conclusions is a success. (`skipped` and `neutral` are acceptable
   only for checks that are not required.)
3. The PR is mergeable — no conflicts.

In `check-ci`'s terms: `CI: PASSED`, `HEAD_SHA` equal to the approved SHA,
`REQUIRED_CHECKS: complete`, every optional check terminal and non-failing,
`UP_TO_DATE: yes|not-required`, and `MERGEABLE: yes`.

This suite intentionally treats `skipped` and `neutral` required checks as non-success,
even on providers whose native merge rule might accept them. Testing for "nothing has
failed" instead would call four different broken states green: a repo with no checks
configured, checks still queued, required checks that haven't started reporting yet, and a
path-filtered workflow that skipped everything.

`CI: NONE`, `CI: BLOCKED`, an exact head mismatch, or unobservable required-check,
strict-policy, or mergeability state fails the issue. `CI: FAILED`, a source conflict, or
`STRICT_POLICY: required` with `UP_TO_DATE: no` on a head the issue-agent called mergeable
also fails it — the fix attempts are spent. Pending human approval is recorded and leaves
the PR for a person rather than failing it.

Issue PRs open ready and carry no reviewer: nobody is asked to review one, because the
review a human actually does is of the epic branch, once, in Phase 2. Publish the green
proof as delivery state through `PUBLISH_STATE` before authorizing the merge.

**A head that no longer contains the epic tip fails the same way.** The branch was built and
tested against an epic branch that has since moved, so its green CI proves nothing about the
integrated result. Send it back to an issue-agent on the existing branch to merge the epic
tip in and take the PR to green again — that CI run is the first thing to have exercised the
integrated head. On a protected target this is what `STRICT_POLICY: required` would enforce;
an `epic/*` branch is usually unprotected, so nothing else does.

With the predicate satisfied, authorize the merge by dispatching `MERGE`. The reread and the
merge live in one context precisely because nothing may come between them:

```
Merge {PR_URL} at exactly {approved full SHA}, and only if it is green at that head.

Immediately before the merge invocation, read
/check-ci --pr={PR_URL} {approved full SHA} --once and require every one of:

{the green predicate above, verbatim}

plus REVIEW_REQUIREMENTS: satisfied|not-required. This closes the race where the target,
checks, or review requirements changed since the authorization was issued. Any non-green
reread, and pending human approval, mean you do not merge — report it and stop.

Then invoke /create-pr --merge --pr={PR_URL} --head-sha={approved full SHA}. create-pr
resolves the repository-preferred merge method through the preflighted delivery binding.
Use whatever the repository prefers and override nothing.

Merge no head other than {approved full SHA}. If you cannot merge that exact head under
those conditions, reporting why is the correct outcome.

Return ONLY:
PR_STATE: merged | queued | unmerged
HEAD_SHA: {the full head the provider reports}
MERGE_COMMIT: {sha or none}
MERGE_QUEUE: {queue identifier or none}
REASON: {why, when not merged}
```

Honor contrary user instructions and branch protection even after CI turns green. Squash is
a common and good repository preference here: the epic branch gets one clean commit per
issue, while the commit-by-commit history stays visible on the PR.

**A merge is confirmed by something other than the agent that performed it.** A tier is not
a guard, and neither is re-reading a report against itself: an agent that merged the wrong
head and transcribed the requested one passes any check made only of its own return. So
`PR_STATE: merged` completes delivery only on two confirmations the merging agent did not
write:

- **A fresh `INSPECT`** — a different agent, reading the forge's own record of which head was
  merged. Require `PR_STATE: merged`, `HEAD_SHA` equal to the approved SHA, a `BASE` of
  `epic/{slug}`, and a `MERGE_COMMIT` that is a full SHA and not `none`.
- **The commit is really on the branch**, read with your own hands:

  ```bash
  git fetch "$BASE_REMOTE" "epic/$SLUG"
  git merge-base --is-ancestor "$MERGE_COMMIT" "$BASE_REMOTE/epic/$SLUG"
  ```

  The check is on the *merge commit*, not the approved SHA. Under a squash preference the
  approved SHA is deliberately not an ancestor of anything — the commit is new — so testing
  for it would fail every squash merge and pass nothing extra.

**Either confirmation failing is contamination**, and the second one failing is the more
alarming of the two: a clean `INSPECT` beside a merge commit that is not on the epic branch
means the PR merged somewhere else — the likeliest cause being a branch that targeted the
default branch rather than `epic/{slug}`, which nothing before this point re-checks. Treat a
`BASE` that is not the epic branch the same way, and do not wait for the ancestry test to
tell you what the base field already said.

**A merged head you did not approve contaminates the epic branch**, and that is a different
kind of failure from a ticket that could not land. Unapproved code is now in the branch every
later issue builds on, that Phase 2 verifies, and that the epic PR would hand a human.
Failing the issue is not a sufficient response, because the issue is not what broke.

So: **halt the run.** Schedule no further issues onto that branch, run no finalization, open
no epic PR. Phase 3 still resolves the ledger — drafted tickets are real work and filing them
costs the branch nothing — and Phase 4 still reports, in this shape instead of its usual one:

```markdown
Epic {name} — HALTED, {n} of {m} issues merged into epic/{slug}, {duration}

CONTAMINATED  epic/{slug} carries a merge this run did not approve.
              issue        #{id}
              approved     {approved SHA}
              merged       {head the forge reports}
              commit       {merge commit}
              found by     {the INSPECT mismatch, or the ancestry test}

DO NOT MERGE  No epic PR was opened. Nothing here is reviewed work.
              The branch needs a person before this epic goes further.

MERGED        {the issues that landed on approved heads, with PR links}
NOT ATTEMPTED {everything the halt cancelled}
```

The usual report leads with the epic PR because that is the thing the run cannot finish for
the user. A halted run has no epic PR, and pretending otherwise — or quietly reusing a format
whose most prominent line is missing — buries the one fact the whole report exists to
deliver. The one thing a run must never do is hand a person a PR that presents unapproved
content as reviewed work — the whole autonomy of this design is borrowed against that final
review being of what the run says it is.

`PR_STATE: queued` creates a persisted pending merge work item containing the PR URL,
approved SHA, and queue identifier; poll it with `INSPECT`. Require every inspection's
`HEAD_SHA` to equal the stored approved SHA too. A mismatch on an inspection that is *not*
yet merged fails the issue; never bless or mark a different head complete. A mismatch on one
reporting `PR_STATE: merged` is not an issue failure at all — the queue merged an unapproved
head, which is contamination, and it halts the run exactly as above. Continue until the
approved head is observed merged or terminally rejected. Any other outcome is a merge
failure: leave the issue open and do not unblock dependents.

Immediately publish `queued` after queue acceptance and `merged` after observed merge using
the scheduler-state procedure above. A queue rejection, CI/policy observation failure,
exhausted CI-fix attempts, or other scheduler terminal path with an existing PR uses the
same procedure with its factual failed state and terminal comment.

Only after observed merge, publish the delivery comment and close the issue through
**Publishing tracker state**. Re-evaluate the graph once the tracker reports it closed as
completed — that observation, not the merge, is what unblocks dependents.

### When an issue fails

Failures are not all alike, and the right response differs enough that a blanket retry
policy would be actively wasteful. The table is a **guideline, not a taxonomy** — if you
hit something that isn't here, reason about it directly: how much did this already cost,
and what is the realistic chance a retry ends differently?

| Failure | Retry? | Why |
|---|---|---|
| The agent died — crash, tool error, context exhaustion | Yes, once | Nothing was learned; it just fell over |
| A push, PR, comment, or state update failed | No | Retrying could duplicate artifacts; preserve the branch and PR for a human |
| CI still red after `--max-ci-fixes` attempts | No | The attempts were the retries; CI is telling you this is not the kind of problem another agent solves |
| A green PR that fails your own pre-merge reread | No | The issue-agent's fix budget is spent, and its claim already disagreed with the forge |
| Blocked on something outside the epic — a schema change, a credential, a decision | Never | Retrying cannot supply what's missing |
| Plan agent refused — ticket too vague | Never | Needs a human |

The expensive failures are the least likely to succeed on a rerun, so a blanket "retry
once" spends the most effort on the least promising work.

**A failed issue keeps its PR and its branch.** Do not close the PR, do not delete the
branch. It also keeps its tracker issue open, with the terminal comment from **Publishing
tracker state** naming the PR and the reason. The work is real and a human will pick it up.
The issue stays incomplete in the graph, so its dependents become **stranded**.

**Never build on failed work.** If #3 fails, do not attempt #4, #5, #6 on #3's branch. That
branch contains code that never got to green; if the human later fixes
#3 differently, everything stacked on it was built on a fiction. Skip the dependents, take
whatever unrelated work is still unblocked, and report the strand at the end.

**A blocked issue is data, not an interrupt.** Record it and keep going. The value of an
unattended run is that nine of twelve tickets land while the user sleeps — not that all
twelve wait for one answer.

### Recording discoveries

Along the way, sub-agents surface things nobody planned for. Collect them in a ledger.

**A discovery is something outside the scope of the ticket being worked** — a bug in a
module this ticket only called into, a missing test suite, a blocker nobody anticipated, an
assumption in the plan that turned out to be wrong. Something you would have written a
ticket for.

**A small deficiency inside the code this ticket touched is not a discovery.** It was either
fixed or consciously left; either way it belongs in the PR, not the ledger. Without this
line the ledger fills with dozens of items an implementer noticed in its own diff, and a
wall of noise is functionally identical to reporting nothing.

The one override: **severity beats scope.** A serious problem the run genuinely could not
resolve deserves a ticket even though it's in-scope, because "we shipped a known hole" must
not evaporate when the session ends.

**Deduplicate.** The same finding noticed while working #3, #5, and #7 is one entry with
three sightings, not three tickets.

**Draft tickets during the run**, not at the end. Drafting needs no dev stack and no CI, so
it is free work for an otherwise-idle moment. Spawn a ticket-writing agent per confirmed
discovery:

```
Investigate and write a ticket for this finding.

Finding: {what was noticed, where, during which issue}

Investigate before you write. Read the code. Check logs and stack traces. Reproduce it if
you can. Research externally if the behaviour depends on a library or platform you're
unsure about. Confirm it is actually real and understand WHY.

If it turns out not to be real, say so and stop — that is a useful answer.

Otherwise write a ticket someone can pick up cold, months from now, with no memory of this
run: what the problem is, the evidence, the analysis, and a recommended approach.

Write it to {state_dir}/discoveries/{n}.md — do not file it.
```

The investigation is the point. A ticket filed from a one-line impression looks reasonable
when written and falls apart when someone picks it up, which is worse than no ticket at
all — it wastes the reader's time and erodes trust in every other ticket the system files.

**Nits that don't individually justify a ticket still shouldn't vanish.** If a run
accumulates a pile of small deficiencies, one combined cleanup ticket listing them all is
right — it keeps the record without spamming the tracker. Use judgment about when the pile
is worth filing; a near-empty cleanup ticket on a clean epic is just noise.

---

## Phase 2: Finalize the epic

Every issue that could land has landed. **This phase is the review** — not a final check on
top of one, the only time anything reads the code the run produced. Per-issue CI proved each
branch builds and passes its tests, which is a different and much smaller claim.

It is also the only place the *integrated* result is visible. Issues that are each correct
in isolation routinely conflict when assembled — a helper two tickets rewrote in different
directions, a contract issue 4 widened and issue 9 narrowed again — and nothing before this
branch could have seen it.

So give it room. Three rounds, remediating as it goes, and the run's whole quality claim
rests here.

**This is the one place in the whole system that asks for `--depth=deep`.** Verification is
light by default everywhere else — a human typing `/verify`, and every turn of a
`player-coach` loop — because a judgement fan-out over a diff that keeps growing does not
converge. That reasoning does not apply here. This pass runs once, over a finished integrated
branch that is not going to grow underneath it, and it is the only review the epic gets. The
cost light exists to avoid is not a cost this phase can incur.

**Run this phase even when some issues failed.** A partial epic still gets reviewed as a
whole; what it does not get is a claim of completeness. The sole exception is a run halted
for a contaminated epic branch — there, reviewing and PR-ing the branch is the specific thing
that must not happen.

### 1. Verify the epic branch

Spawn a verification agent. It holds the report so you don't:

```
Verify the epic branch as one integrated change.

Check out epic/{slug} and invoke:
/verify --depth=deep --mode=report-only --scope=branch --base={BASE_REMOTE}/{target}
        --format=json --output={state_dir}/epic-verify/{round}.json

Return ONLY these three lines:
BLOCKING: <count of issues at severity {severity} or above>
TOTAL: <count of all issues>
REPORT: {the output path}

Return no findings, no descriptions, and no narration — the orchestrator does not read
verification reports and cannot afford the context.
```

Zero blocking findings ends this phase; go to step 4.

### 2. Plan the remediation

Spawn a remediation-planning agent, which reads the report you did not:

```
Write a remediation plan for the findings in {report path}.

The epic branch epic/{slug} is complete and its individual issues are merged. Verification
of the integrated result found blocking issues. Read that report and the code, and write a
plan to fix them.

Write the plan to {state_dir}/plans/remediation-{round}.md

Fix what was found. Add no functionality: anything that looks like new scope belongs in a
follow-up ticket, not in this plan — say so in the plan rather than planning it.

If a finding is not real, say so in the plan and explain why, instead of planning a change
that exists to satisfy a reviewer.
```

### 3. Run the remediation

An ordinary issue-agent on an ordinary branch — the same brief you already use for an
issue, with `{state_dir}/plans/remediation-{round}.md` as the plan and branch name
`epic-{slug}-remediation-{round}`.

Then take it through the same merge path as any issue. It lands on its own PR, exactly like
every other run, which is why it does not need a special case.

**Then return to step 1.** At most three verification rounds total: verify, remediate,
verify, remediate, verify. Anything still blocking after the third goes to the human in the
completion report — a loop that keeps finding work in its own fixes is telling you the epic
needs a person, not another round.

### 4. Open the epic PR

Write a context file from the run's own state — the per-issue outcomes, the verification
result of each finalization round, and anything left blocking — then dispatch
`OPEN_EPIC_PR` with `epic/{slug}`, `{target}`, and that path. The delivery-agent checks out
`epic/{slug}` and opens the draft PR against `{target}`; `create-pr` opens the PR for the
checked-out branch, so the checkout is what selects the head — which is why the epic branch
is a parameter and not something the agent infers.

It returns `PR_URL`, `PR_STATE`, `BASE`, `HEAD_REF`, and `HEAD_SHA`. Require all four to
agree with what you asked for: `PR_STATE: draft`, `BASE` of `{target}`, `HEAD_REF` of
`epic/{slug}`, and a `HEAD_SHA` equal to the epic tip you fetch yourself —

```bash
git fetch "$BASE_REMOTE" "epic/$SLUG"
git rev-parse "$BASE_REMOTE/epic/$SLUG"
```

The fetch is not optional. A remote-tracking ref is only as fresh as the last fetch, and
every merge this phase follows landed on the remote after Phase 1's — a stale ref rejects a
correct PR at the run's final step just as readily as it blesses a wrong one.

— because the checkout that selected the head happened out of your sight. `BASE` and
`PR_STATE` alone would pass a PR opened from the wrong branch, or a pre-existing draft
against the same target, and this is the one artifact the whole run hands a person.
The dispatch carries the rule below — **open this PR as a draft and stop there**, no merge,
no ready.

The context file is the epic summary for a human reviewer; it is not `epic-context.md`, which
is the reviewer-facing backlog and has no place in a PR body.

**This is the one PR that targets the default branch**, so it is the one PR whose body can
promise closure. The context carries the epic's closing linkage line, and the human's merge
closes the epic ticket atomically with the delivery it describes.

**Leave it as a draft, and never merge it.** This is the whole reason the run could be
autonomous: a human reads one integrated branch, exercises it however they exercise things,
and merges it themselves. Marking it ready or merging it would quietly convert a reviewed
hand-off into an unreviewed deployment.

---

## Phase 3: Resolve the ledger

Depends on `--new-issues`:

- **`create`** — file the drafted tickets, one `FILE_TICKET` dispatch each.
- **`propose`** (default) — present them for approval, then file the approved ones. Because
  they were drafted during the run, the user is approving finished tickets rather than
  one-line summaries and a promise.
- **`never`** — file nothing; the drafts remain in the state directory and appear in the
  report.

A binding whose `create` is a no-op or was never resolved degrades the same way `comment` and
`close` do: the drafts stay in the state directory, the completion report carries them, and
Phase 0's confirmation already said so. `--new-issues=never` needs no `create` at all, so a
missing one is only ever a blocker for the other two policies.

**Every tracker write says it came from an agent.** Comments and tickets post under the
user's account, and a human reading them later must not have to guess whether a person
wrote them. A short line at the top is enough — no ceremony, just don't let it be
ambiguous.

---

## Phase 4: Completion report

Lead with what needs a human. The merged list is the boring part — those PRs can be read at
leisure. The three lines demanding action must be unmissable in the first screenful.

```markdown
Epic {name} — {n} of {m} issues merged into epic/{slug}, {duration}

REVIEW THIS  {epic PR url}  — draft, unmerged, waiting for you

MERGED       #41 #42 #43 #44 #45 #47 #48 #50 #51
             {PR links}
NEEDS YOU    #46  CI still red after {n} fix attempts. PR {url} open.
             #49  plan agent refused — ticket doesn't specify {thing}.
STRANDED     #52  blocked by #49

EPIC VERIFY  round 1: {n} blocking → remediation merged; round 2: clean
             {or: round 3 still flags {thing} — the epic PR carries the detail}
FRICTION     {CI failures and the fix attempts they cost, issues sent back to
             absorb a moved epic tip}
PERFORMANCE  {issues green on their first CI run, CI-fix attempts per issue,
             blocking findings per epic-verification round}
DISCOVERIES  {n} tickets drafted{, awaiting approval}{, + 1 combined cleanup ticket}
```

The epic PR leads because it is the one thing the run cannot finish for the user.

Then, with write-back on, post the report as a `COMMENT` on the epic ticket and **leave the
epic open.** Clean verification is not delivery: the epic PR is still a draft against the default
branch, and until a human merges it nothing the run produced has shipped. An open epic ticket
states that accurately, and the `Closes` linkage in that PR closes it the moment the human
merges — atomically, with the delivery it describes.

---

## State

Run state lives outside the repository, in `$XDG_STATE_HOME/epic-runner/{project}/{epic}/`
(falling back to `~/.local/state/...`, then `~/.epic-runner/`):

```
plans/{id}.md          materialized implementation plans
plans/remediation-{n}.md  the finalization plans written from each epic verification
issues/{id}.md         per-issue journey logs written by issue-agents
discoveries/{n}.md     drafted follow-up tickets
epic-context.md        completed / current / remaining issues, handed to planners and implementers
epic-verify/{n}.json   the verification report for each finalization round
run.json               status blocks, approved HEAD SHA, pending merge-queue work, inferred edges, CI-fix counts, failure reasons, and any halt
```

`epic-context.md` and every report under `epic-verify/` are paths you hand to sub-agents and
never read yourself. The first carries knowledge between issues; the rest are verification
reports, and the rule against reading those has not changed.

Never in the repository — a long epic would litter the working tree and pollute the diffs
being reviewed. Never in `/tmp` — a reboot mid-run would destroy the ledger and every
drafted ticket.

**The tracker owns lifecycle; `run.json` owns evidence.** Lifecycle is pending / active /
completed / failed, the durable PR linkage, and what unblocks dependants — all human-visible,
all written back as Phase 1 goes. Evidence is the approved head SHA, the CI proof, merge-queue
identifiers, retry counts, plans, journey logs, and unpublished drafts: technical, private,
and never the sole record that an issue completed.

**A halted run is recorded in `run.json`, and a resume does not clear it.** Write the halt —
the issue, the approved SHA, the head actually merged, and the merge commit — the moment you
declare one. A contaminated epic branch is still contaminated at hour six or next Tuesday,
and nothing about restarting resolves it. On finding that record, report it and stop; only a
human who has looked at the branch can say what the run may do next. Resuming past a halt on
the grounds that the local state looks workable is the single worst thing this skill could
do, because it is how unapproved code reaches a human labelled as reviewed work.

On resume, re-read the tracker *first*, then the open PRs. **A child observed closed as
completed is not reimplemented**, whatever the local file says. Where local evidence is
missing, reconstruct delivery from the agent-attributed delivery comments and an `INSPECT`
dispatch per PR. Where the two disagree, surface the disagreement in the report rather
than resolving it into a second implementation of shipped work.

**An open PR goes to the merge check only on a head an issue-agent finished.** Adopt it when
`run.json` holds a `MERGEABLE` block for that issue whose `HEAD_SHA` equals the PR's current
head, observed through `INSPECT`. A head that moved since — or an issue with no
such record — was left mid-flight, so it goes back through an issue-agent on its existing
branch rather than to the merge check. Never derive approval from the current PR head, from
tracker state, or from a `run.json` entry that disagrees with what the forge reports.

**Resume rejoins; it does not restart.** An issue whose PR is open and mid-CI is picked up on
its existing branch — not re-implemented on a second branch. This is why the issue id
belongs in every branch name and PR body: it's how you recognise what you're looking at.

With `--write-back=off` there is no durable record that an issue was completed, so
resumability genuinely degrades. Say so rather than pretending otherwise.

---

## Standing rules

- **Don't write code.** Issue-agents do that.
- **Don't verify.** `verify` runs inside the finalization agent in Phase 2, where you see
  three lines of it.
- **Don't read verification reports or diffs.** Your context is the resource that has to
  last the whole run.
- **Don't call the forge yourself.** You never invoke `create-pr` or `check-ci`, and you
  never mutate the tracker; delivery-agents do both and hand you fields. Issue-agents run
  those skills too, inside their own contexts — the rule is about yours.
- **Never resume past a halt.** A contaminated epic branch stays contaminated; only a human
  who has looked at it can say what happens next.
- **Never merge the epic PR.** Open it as a draft and hand the human the link. The run's
  autonomy is borrowed against that final human review; merging it spends something you were
  not given.
- **Never bypass branch protection**, weaken a rule, or self-approve to unblock a merge.
- **Never merge a PR that isn't affirmatively green and mergeable.**
- **One dev-stack consumer at a time.** Implementing an issue counts, from its first commit
  to its green PR; planning, drafting, and merging do not.
- **Never interrupt the run for a decision** that Phase 0 could have settled.
- **Every ticket you file is a real ticket** — investigated, evidenced, actionable. There is
  no project where a sloppy ticket is acceptable; a throwaway repo just means nobody is
  there to complain about it.

## Harness bindings

The logic above is harness-neutral. These are the Claude Code mechanisms it maps onto; on
another harness, swap this section and leave everything else alone.

| Capability | Claude Code |
|---|---|
| Spawn an isolated sub-context | `Agent` tool |
| Give a sub-agent its own checkout | `isolation: "worktree"` on `Agent` |
| Research and draft without being able to edit | plan mode — `EnterPlanMode` / `ExitPlanMode` |
| Invoke another skill | `Skill` tool |
| Choose a model per sub-agent | `model` on `Agent`, or the skill's frontmatter |
| Concurrency budget for the whole agent tree | none encountered; where a harness has one, it is set on the launching invocation and children inherit it |

**If the harness caps concurrent sub-agents, that cap is yours to get right**, because it
is a property of the outermost invocation and this skill is the outermost invocation. It has
to accommodate the deepest point of the tree, not the widest: in Phase 2, `verify` fans out
to nine sub-agents while two ancestors — this scheduler and the epic-verify agent — are still
active. A cap sized for what any one layer wants leaves the bottom layer with nothing, and
the symptom is not an error but a review pipeline that quietly runs one reviewer at a time.

### Model tier per role

The tree spans work of wildly different weight, and a single tier across all of it is either
wasteful at the bottom or negligent at the top. These are cost tiers, not models — the
orchestrator picks the model, and picks against these defaults.

| Role | Tier |
|---|---|
| orchestrator — this skill | top |
| plan-agent, remediation-planning agent | high |
| epic-verify-agent | high — and not for its own sake |
| issue-agent, ticket-writing agent | mid |
| delivery-agent on `MERGE` | mid — it is the last gate before an irreversible act |
| delivery-agent, every other operation | low |

**Spend on the plan so the implementer doesn't have to reason.** A plan-agent runs a tier
above the issue-agent that consumes it, deliberately: no reviewer reads an issue before it
merges, so the plan is the entire requirements document and the cheapest place in the
pipeline to be smart. An issue-agent working from a good plan is executing, not designing.
Raise one a tier where a ticket is genuinely heavy — a default is a starting point.

**`MERGE` is the exception that proves the delivery-agent is cheap.** Everything else it does
is a command and a transcription. `MERGE` is not: it reads the pre-merge green predicate and
decides, and your authorization was issued before that evidence existed, so nothing after it
re-checks. The last gate before an irreversible act does not sit on the cheapest model in the
tree — one dispatch per ticket at a tier that can be trusted to apply a predicate exactly is
the cheapest insurance in this design.

**The epic-verify-agent's tier is not about the epic-verify-agent.** Its own job is three
lines: invoke `verify`, return counts. But where a harness has sub-agents inherit their
parent's model absent an explicit choice, its tier is the tier of all nine reviewers beneath
it. Phase 2 is the only review the epic gets — there is no per-issue verification anywhere in
this skill — so a cheap dispatcher buys almost nothing and quietly downgrades that review.
Choose its tier for its children.
