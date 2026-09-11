---
name: renovator
description: >-
  Sweep a repository's open dependency PRs (Renovate, Dependabot, or similar): tier each
  by risk, merge the trivial green ones, research and verify the rest, and leave one
  upserted comment per PR a maintainer can act on in under five minutes.
argument-hint: "[<PR refs...>] [steering in prose, e.g. treat playwright as guarded]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - Skill
  - TodoWrite
metadata:
  group: ship
  requires: [check-ci, create-pr, exerciser, debugger]
  optional: [research]
---

# Renovator — Unattended Dependency-PR Sweep

A dependency bot opens PRs faster than anyone reads them, and each one costs a maintainer
the same loop: read the PR, read the changelog, work out what touches this repository,
verify it, decide. You run that loop across every open dependency PR in one **sweep** —
survey them, **tier** each by risk, merge the trivial ones against a **fresh** green
reading, research and verify the rest, and leave exactly one comment per PR carrying its
**verdict** and whatever a maintainer needs to act.

The run is unattended and self-ending. It asks nothing: the comment on the PR *is* the
question, and a maintainer's reply on it is the answer the next sweep reads. That is why
`AskUserQuestion` is absent from the tool list above.

You stay generic. Everything true of *this* repository — which packages deserve a harder
look, which verification proves which kind of dependency, where the fragile ground is —
lives in `DEPENDENCIES.md` beside the engineer skill, and the sweep starts only once it
is there.

## Input

```
/renovator                              sweep every open dependency PR
/renovator 412 415                      limit the sweep to these PRs
/renovator treat @types/* as guarded    steering for this run only
/renovator 412 skip playwright checks   both
```

Numeric references and PR/MR URLs limit the sweep. Every remaining word is **steering**:
prose that adjusts the defaults for this run alone. Precedence runs invocation steering >
`DEPENDENCIES.md` > the generic defaults below.

Two invariants survive any steering, from any source:

- **A major bump of a runtime dependency merges only after a maintainer's reply says so.**
- **An opportunity ends its PR at `commented`**, whatever the tier — a version worth
  adopting is a decision a human makes.

---

## Phase 0: Readiness gate

Establish that this sweep has a repository to act on and a binding to act by.

1. Confirm a git repository with a configured remote, resolve its canonical provider
   identity, and confirm the provider CLI is authenticated. Follow
   [`references/providers.md`](references/providers.md) — read it whole before the first
   provider call.
2. Locate the engineer skill and keep the directory as `ENGINEER_SKILL_DIR`:

   ```bash
   find . -maxdepth 4 \( -type d -o -type l \) -name '*-engineer' \
     -not -path '*/node_modules/*' -not -path '*/.git/*'
   ```

   A glob pair such as `.*/skills/*-engineer/ */skills/*-engineer/` looks equivalent and is
   not: under `zsh` an unmatched pattern aborts the whole command before `ls` runs, so a
   repository that satisfies one pattern and not the other yields nothing at all — and a
   bare top-level `skills/<name>-engineer/` satisfies neither.

   Resolve every hit to its real path. Repositories commonly expose one skill directory
   under several names, and identical real paths are one directory. Genuinely distinct
   engineer skills end the run `BLOCKED` naming both: which binding governs a merge is not
   a guess worth making.

3. Read `$ENGINEER_SKILL_DIR/DEPENDENCIES.md` as `DEPS`, plus the `TESTING.md` and
   `GOTCHAS.md` beside it.

Either file missing ends the run here, with the terminal output and nothing else:

```
BLOCKED — renovator needs the repository binding it must not invent.

engineer skill    .agents/skills/widgets-engineer/    found
DEPENDENCIES.md   —                                   missing

Run /setup-engineer to draft it, then re-run /renovator.
No pull request was read, commented on, or merged.
```

**Done when** both files are read, the provider is authenticated, and the remote's
canonical identity matches the repository the sweep will act on.

## Phase 1: Survey

Read every in-scope PR once, and decide what kind of run this is before touching anything.

**Detect dependency PRs** by author plus body structure, per providers §Detect — a bot
account and the release-notes/config-summary body a dependency bot generates. A human PR
that slipped into the scope list gets verdict `blocked` and is left alone.

For each dependency PR, extract:

- packages, each `from → to`, and the bump kind (patch, minor, major, digest, pin,
  lockfile maintenance)
- the manifest sections the packages sit in, and their **role** — derived per
  [`references/verification.md`](references/verification.md)
- grouped members, when the bot batched several updates into one PR
- **fresh or stale**: whether the head includes the current target tip
- whether the bot's own config already automerges this PR
- the existing `<!-- renovator -->` comment and any replies newer than it

Then **tier** each PR with [`references/tiers.md`](references/tiers.md): the generic matrix
first, `DEPS` adjustments over it, invocation steering over that.

Then build the **cross-PR picture**, which no single PR shows: the same package bumped in
two PRs, several PRs moving one toolchain, and every set that shares a lockfile. This is
what makes the merge order in Phase 3 safe.

Print the survey table (PR, dependency, bump, role, tier, freshness) before dispatching
anything.

**PRs the bot automerges itself** are compared, not simply skipped. Read the bot's automerge
rule from its config and hold it against the tier you just assigned:

- **The rule is at least as strict as the tier** — it would only automerge what you call
  trivial. Verdict `delegated`; the bot is driving and a second actor only races it.
- **The tier exceeds what the rule reviews** — the common case, because bot rules are written
  by bump kind while a tier is decided by role. A config that automerges every patch and minor
  merges engine bumps, base images, and build tooling with nothing having read them. These get
  the full attentive treatment — research, verification, comment — and verdict `commented`.
  You never merge one: the bot owns the merge.

That second case is the sweep's whole value on an automerge-heavy repository, and it is a
race you will sometimes lose. Write the comment to survive being late: address it to the
**rule** rather than to the PR, so it still reads correctly under a merged banner, and name
the narrower rule that would have caught this one.

**Done when** every in-scope PR has a tier, a freshness reading, and its cross-PR
relationships recorded.

## Phase 2: Rebase requests first

A stale PR proves nothing: its CI ran against a target tip that has moved. Rebases are
requested **one at a time**, from a queue.

**The arithmetic is why.** Where the target requires branches to be up to date, a merge
re-stales every sibling and voids its green CI. Rebase all N stale PRs and N full CI runs
start, exactly one can merge, and the other N−1 are rebased again — **N(N+1)/2 runs to drain
N updates**, on runners a repository has a fixed number of. Serial costs one run per update
landed. On a repository with an hour-long suite and three runners, that difference is the
difference between a sweep and an outage.

**Where `DEPS` names a scheduler that owns rebases, request none at all.** A repository that
has built its own dependency scheduler has already priced this, usually more precisely than
you can from outside, and two schedulers nudging the same branches is worse than either
alone. Work the sweep on the PRs as you find them, and say in the run table that rebases
belong to that scheduler.

Otherwise: order the stale PRs — trivial first, since those are the ones that actually drain,
then by tier — and work the queue.

1. Request a rebase for the head of the queue (providers §Rebase). Record its head SHA and
   the time; the bot's turnaround is the **patience clock**, default 30 minutes, steerable
   in `DEPS` or on invocation.
2. Wait on CI with `check-ci` in watching mode, `CI_CHECK_TIMEOUT` set to the seconds left
   on the clock, so a bot that never rebases ends `waiting` instead of stalling the sweep.
3. When that PR reaches any verdict, request the next.

**The queue serializes CI, not thinking.** Research and verification for every other PR run
throughout — they cost no runners. Only the rebase requests and the merges are single-file.

Where `check-ci` reports `UP_TO_DATE: not-required`, staleness gates nothing and the queue
can be as wide as the runners allow. Read the policy rather than assuming either shape, and
say in the run table which one you found.

**A push by anyone other than Renovate is terminal for that branch.** Renovate abandons it
permanently, and the rebase checkbox stops working too — so a branch someone has pushed to
has lost its only cheap route back to fresh, in a repository where every merge to the target
re-stales it. Read **Writes to the bot branch** before touching one.

**Done when** rebasing has an owner: either a scheduler `DEPS` names, or a queue you
ordered whose head carries a request and a deadline while every other stale PR knows its
place in line.

## Phase 3: Trivial first

Trivial PRs are the sweep's cheapest win, and merging them early shrinks what the rest has
to reason about. Take them **in lockfile-aware order**: PRs sharing a lockfile go one at a
time, because merging one makes its siblings stale.

For each trivial PR:

1. `check-ci --pr=<ref> --once`.
2. Merge on the full predicate, from that single fresh reading: `CI: PASSED`,
   `MERGEABLE: yes`, `REVIEW_REQUIREMENTS: satisfied | not-required`, and `HEAD_SHA` equal
   to the SHA the survey (or the rebase) recorded. Anything else moves the PR into the
   Phase 4 queue.
3. When review is required, approve first (providers §Approve) — immediately before this
   merge, after the last push, and never as a standing act.
4. `create-pr --merge --pr=<ref> --head-sha=<sha>`. `PR_STATE: merged` is verdict `merged`;
   `PR_STATE: queued` is verdict `waiting` with the queue identifier.
5. Leave the two-line merge comment (what moved, what proved it green).
6. Advance the rebase queue: this merge just staled every sibling, so the next request goes
   to the next PR in line, not to all of them.

A red trivial PR is not a trivial problem — it joins the Phase 4 queue with its tier
unchanged and gets an agent of its own.

**Done when** every trivial PR is merged, queued, or in the Phase 4 queue.

## Phase 4: Dispatch

Every attentive PR, every guarded PR, and every red trivial PR gets **one sub-agent with
its own context**, briefed below — including the automerge-armed PRs Phase 1 kept, whose
ceiling is comment-only whatever their tier, because the bot owns their merge. How many run at once, and at what cost tier, is your
judgment: a lockfile-maintenance PR and a major framework bump are not the same work.

Two constraints shape the fan-out:

- **Parallel agents that start the app need distinct env-index values** — the repository's
  `<PROJECT>_ENV_INDEX` variable, named in the engineer skill's port contract. Where you
  cannot assign them, run those agents one at a time.
- **Merges stay serialized** by the fresh-head rule: an agent merges against a reading it
  took itself, so two agents merging into one target must not overlap.

Collect each agent's returned record. You never read its logs, its diffs, or the changelog
text it worked from.

**Done when** every dispatched PR has returned a verdict record.

## Phase 5: Close

1. Take a final `check-ci --pr=<ref> --once` for every PR sitting at `waiting`, and promote
   any that has since gone green and mergeable through the Phase 3 merge steps.
2. Remove every worktree the run created and prune the administrative files —
   `git worktree remove <path>` then `git worktree prune` — on **every** path out of this
   phase, including the one where an agent failed.
3. Print the run table:

```
PR    Dependency                    Tier       Verdict     Reason
412   @types/node 20.11 → 20.14     trivial    merged      green at 4f21ab9
415   vitest 1.4 → 1.6              attentive  merged      suite green, no API we use changed
418   fastify 4 → 5                 guarded    commented   plugin encapsulation change hits src/routes
421   node 20 → 22 (engines)        guarded    commented   awaiting maintainer reply
423   eslint 8 → 9                  attentive  waiting     rebase not delivered within 30m
425   esbuild 0.21 → 0.24           attentive  commented   bot automerges minors; this one is build tooling
427   prettier 3.2 → 3.3            trivial    delegated   bot automerge, rule no broader than the tier
```

Say which rebase shape the run used — serial under a strict target, wide, or owned by the
repository's own scheduler — since it is the first thing a maintainer wondering why a sweep
took two hours will ask.

**Done when** every in-scope PR appears in the table with a verdict, and `git worktree list`
shows nothing this run created.

---

## The PR agent brief

One agent, one PR, one context. Hand it everything it needs so it reads no PR but its own:

```
PROVIDER + REPO      provider binding, repository path, base branch
PR                   ref, head SHA at survey, freshness, rebase requested at, patience deadline
DEPENDENCY           packages, from → to, bump kind, roles, grouped members,
                     manifest locations, import sites in this repository
CEILING              may merge unaided: yes | no
                     may push a bounded fix: yes | no
CROSS-PR             siblings sharing a lockfile, the same package elsewhere in the sweep
BINDINGS             ENGINEER_SKILL_DIR, DEPENDENCIES.md path, steering verbatim
HISTORY              existing renovator comment body, replies newer than it, and for each
                     reply whether its author has write access
WORKTREE             work in a git worktree on a fresh branch off the PR head, with its
                     own value of the repository's env-index variable
RETURN               the record below and nothing else — no logs, no changelog text
```

The tier reaches the agent as those two booleans rather than as a name, so the agent applies
a ceiling instead of re-deciding a risk judgment you already made.

**Fixed order inside the agent:** research → fresh reading → verification → verdict → at
most one bounded fix, and only where that verdict is a merge → comment upsert → (where the
ceiling allows, and the head is green and fresh) approve-if-required → `create-pr --merge`.

The verdict precedes the fix deliberately: a push is a one-way door, so the decision to walk
through it is made before the hand is on it.

**Returns:** PR, dependency, tier as finally raised, verdict, head SHA acted on, a one-line
reason, comment URL, push made (SHA or none), approval given, siblings now stale, and the
verification gap worth a `DEPENDENCIES.md` row (or none).

## Tiers

Three tiers, and each one is a ceiling on what happens without a human:

| Tier | Merges unaided | Pushes a bounded fix |
|---|---|---|
| trivial | when green and fresh | yes |
| attentive | when research and verification turn up nothing notable | yes |
| guarded | no — always `commented` | no |

Findings raise a tier mid-run: a changelog entry that lands on code this repository actually
calls makes an attentive PR guarded, and the comment says so. Only steering set before the
run lowers one — a discovery never argues its own PR down.

The full bump-kind × role matrix, the grouped-PR rule, and the steering phrases that move a
tier live in [`references/tiers.md`](references/tiers.md).

## Research

Depth follows the changelog. A release with a real changelog entry for the versions in the
bump range is the cheapest possible source — read it. A thin, generated, or absent changelog
means going to the package's own source diff, scoped to the APIs this repository imports,
rather than reading the whole release.

Where the `research` skill is installed, it earns its cost on a bump whose changelog points
outward — a migration guide, an upstream RFC, a deprecation with a date.

Output three lists, each scoped to *our* usage:

1. **Breaking or behavioral changes that touch code we call.**
2. **Fixes we benefit from** — worth one line in the comment.
3. **Opportunities** — something new worth adopting. An opportunity ends the PR at
   `commented`, always.

## Verification

Verification answers one question: does this repository still work with the new version?
Derive the dependency's **role** first, then pick from what the repository actually has —
[`references/verification.md`](references/verification.md) holds the role derivation and the
menu per role; `TESTING.md`, `GOTCHAS.md`, and `DEPS` say which commands this repository
offers. Commands come from `just --list` and `DEPS`, never from memory.

Verify in a **git worktree on a fresh branch off the PR head**, so the sweep's other work
and the repository's own working tree stay untouched.

Where the change deserves exercising, invoke `exerciser` with the same shape `verify` uses:
the engineer skill path, an explicit environment start, what to exercise, and what counts as
proof. Where CI is the only signal and it came back `FAILED`, `debugger` reads the failure
before anything is written down.

**Read the shape of a red before believing it.** A dependency bump breaks the lanes that
touch that dependency. Every lane failing at once — unit, build, lint, containers, the ones
with no path to the package — is the signature of a stale branch or a broken CI harness, not
of eight subsystems that a version bump took down together. Report it as what it is: the
finding is "this branch cannot be judged until it is fresh", the verdict is `waiting`, and
the bump is neither blamed nor cleared.

**A missing verification the tier needs is a finding, not a shrug.** The PR ends
`commented`, naming the gap plainly, and the run table suggests the `DEPENDENCIES.md` row
that would close it next time.

## Writes to the bot branch

A push to a bot branch is a **one-way door**: Renovate hands that branch back to nobody, and
its checkbox stops working, so the branch can never re-sync with a moving target again. Push
only as a commitment to drive that PR to merge in the same run — which means only where the
tier already allows merging unaided and the fix is **mechanical and confined**:

- regenerating a lockfile
- a renamed config option
- an import path rename
- a type fix forced by a stricter signature
- a snapshot update the new version's output justifies

One attempt. A trivial PR fixed this way merges when it comes back green — that is the whole
case for pushing at all. Everywhere else the fix travels as a **diff in the comment**, so a
maintainer applies it to a branch that is still alive: on a guarded PR, on any PR whose
findings will end it `commented`, and on an attentive PR that a push would strand halfway.

The temptation to fix first and decide after is exactly what this bound exists to stop. A
stranded bot branch costs more than the bump was worth: the bot stops maintaining it, and
someone has to re-do the update by hand.

Anything larger than the list above is the comment's business, described in words.

## The comment

One comment per PR, carrying `<!-- renovator -->` as its first line, **upserted in place** —
found by that marker and edited, so a PR that survives five sweeps still shows one comment.
It is the run's memory: everything the next sweep needs to know is in it.

Renovator owns this comment directly through the provider (providers §Comment), because
`create-pr` writes only a PR description and posts no comments at all.

Keep it under five minutes to read. Content follows the situation rather than a template —
a trivial merge deserves two lines, a major runtime bump deserves the findings scoped to our
imports, the verification that ran, and the specific thing a maintainer must decide. State
plainly when an approval was given and why. Where the right answer is to stop taking this
update at all, that is a recommendation in the comment: renovator never closes a PR and
never adds an ignore rule.

## Maintainer replies

A reply on the renovator comment, newer than its last update, from an author with **write
access** (checked through the provider, providers §Access), is an instruction. It lifts or
narrows the ceiling **for that PR only**, this sweep and later ones, and the next comment
says which reply it acted on.

Where the access check comes back negative or cannot be read at all — a 403 is ordinary —
the reply is commentary: worth quoting in the comment, never an authorization.

## Verdicts

| Verdict | Means |
|---|---|
| `merged` | merged at a stated SHA, or accepted into a merge queue |
| `commented` | the comment carries the findings and the decision a human owes |
| `waiting` | green is still pending — CI, a rebase, or a merge queue |
| `delegated` | the bot's automerge owns this PR *and* its rule is as strict as the tier |
| `blocked` | out of scope; the PR was left untouched |

`delegated` and `blocked` are the two verdicts that leave a PR untouched.

## Harness bindings

The logic above is harness-neutral. These are the Claude Code mechanisms it maps onto; on
another harness, swap this section and leave everything else alone.

| Capability | Claude Code |
|---|---|
| Spawn an isolated sub-context | `Agent` tool |
| Give a sub-agent its own checkout | `isolation: "worktree"` on `Agent`, else `git worktree add` |
| Invoke another skill | `Skill` tool |
| Choose a cost tier per sub-agent | `model` on `Agent` |

These are cost tiers, not models — you pick the model. A lockfile-maintenance PR is a low
tier; a major runtime bump whose agent may merge is the highest tier in the run, because
it is the last judgment before an irreversible act.
