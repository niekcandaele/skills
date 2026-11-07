# Skills

A source repository of reusable agent skills, published for anyone to install or copy. The skills encode one engineer's opinionated development flow; several only make sense installed together.

## Language

**Harness**:
The program that loads and runs a skill.
_Avoid_: agent, client, runtime, tool

**Skill**:
A directory containing a `SKILL.md` and any supporting files, describing a procedure a harness can follow.
_Avoid_: command, prompt, plugin

**Suite**:
A set of skills that only work correctly when installed together.
_Avoid_: group (collides with `skills.sh.json`'s `groupings` field), bundle, pack

**Standalone**:
A skill that works with no other skill from this repository installed.
_Avoid_: independent, self-contained

**Harness-neutral**:
Written so it works on any harness, with no reference to a specific harness's tool names, directory layout, or features.
_Avoid_: generic, portable, degrades gracefully

**Engineer skill**:
A per-repository skill describing how to build, test, and run that repository, which other skills read for project-specific context.
_Avoid_: project skill, repo skill, local skill

**Run**:
One complete player–coach invocation, from setup through one terminal status.
_Avoid_: session, loop (the run contains loops)

**Player turn**:
One invocation of the player skill and its resulting semantic commit or explicit no-op.
_Avoid_: iteration, attempt

**Verification run**:
One invocation of the verify skill, including a same-player-turn rerun.
_Avoid_: coach turn, review pass

**Run ledger**:
The durable per-run record of every finding, its disposition, and every player turn and
verification run, held outside the repository and re-read rather than remembered.
_Avoid_: state file, memory, cache, history

**Disposition**:
What a run has decided about one finding: `open`, `fixed`, `accepted-below-threshold`,
`deferred-out-of-scope`, or `quarantined`.
_Avoid_: status, resolution, triage

**Quarantine**:
A once-diagnosed failure proved pre-existing and untouched by the change, recorded so no
later verification run, gate, or player turn pays to rediscover it.
_Avoid_: known issue, ignore list, allowlist

**Implementation journey**:
The synthesized narrative in the final PR body that explains player turns, verification,
friction, testing, and terminal state.
_Avoid_: log, transcript, summary

**Evidence store**:
The per-branch directory, held outside the repository, where verification captures land so a PR can show them. Defined by the `evidence` skill.
_Avoid_: artifacts dir, screenshot folder, scratch

**Evidence entry**:
One capture in the **Evidence store**: a claim, its files, the command that produced it, and the head SHA it ran against.
_Avoid_: artifact, screenshot (a screenshot is one kind of entry)

**Before capture**:
The same view or command captured against the merge base, so a reviewer can compare it with the change. It is the default unless the feature is new.
_Avoid_: baseline (verify already uses that for a pre-existing failure), snapshot

**Fresh**:
An **Evidence entry** whose head SHA equals the PR's head. Only fresh entries count as verified in a Testing Plan.
_Avoid_: current, valid, up to date

**Gap-fill**:
The exerciser pass that runs while CI is running, covering only the Testing Plan checks that no fresh entry proves. `create-pr` runs it on its default path; `player-coach` runs it before marking a PR ready.
_Avoid_: re-test, second pass

**Dependency PR**:
A pull or merge request opened by a dependency-update bot (Renovate, Dependabot, or similar), identified by its author and body structure.
_Avoid_: bot PR, renovate PR (the term is bot-agnostic)

**Risk tier**:
The renovator's generic classification of a dependency PR, decided from bump size, dependency role, and changelog: `trivial`, `attentive`, or `guarded`. Sets the ceiling on what the renovator may do unaided.
_Avoid_: risk level, severity, category

**Verdict**:
What the renovator concluded about one dependency PR and the action it took: `merged`, `commented`, `waiting`, or `blocked`. Recorded in the PR comment, which is re-read on the next invocation.
_Avoid_: result, outcome, decision

**Steering**:
Repository-specific instruction that narrows or widens the renovator's generic defaults, supplied by the repository (beside its engineer skill) or on invocation. The skill stays generic; the repository carries the detail.
_Avoid_: config, override, policy

**Opportunity**:
A finding that a dependency's new version offers something the repository should adopt, as opposed to something it breaks. An opportunity blocks the merge until a human has looked.
_Avoid_: suggestion, improvement, nice-to-have

## Relationships

- A **Suite** contains two or more **Skills**; a **Skill** may belong to several
  (`tester` is required by both the verify and review-pr suites)
- A **Skill** required by no other **Skill**, and requiring none, is **Standalone**
- A **Suite** may itself be a member of another **Suite** (`verify` is a suite, and
  `player-coach` requires it)
- Several **Skills** read the **Engineer skill** of the repository they run against
- A **Skill** is **Harness-neutral** or it names the **Harness** it requires
- A player–coach **Run** contains one or more **Player turns** and **Verification runs**
- A published **Run** leaves ordered commits and PR state on the forge; its final PR body
  presents the **Implementation journey** synthesized from those and the **Run ledger**
- A **Run** maintains exactly one **Run ledger**, which is never published and is
  authoritative for everything the run decided, on resume included
- Every finding in a **Run ledger** carries one **Disposition**; a finding still `open`
  after more than one **Verification run** is sticky
- A **Quarantine** entry suppresses a finding at the verification gate only, never at CI

- A **Dependency PR** receives exactly one **Risk tier** and, per invocation, one **Verdict**
- **Steering** can move a **Dependency PR** between **Risk tiers**; the generic default never does more than the tier allows
- An **Opportunity** on a **Dependency PR** forces the **Verdict** to `commented`, whatever the **Risk tier**

- An **Evidence store** belongs to one branch and holds many **Evidence entries**; capture
  skills write entries, and only `create-pr` publishes them
- A Testing Plan check is verified only by a **Fresh** entry; a stale entry is a hint for
  **Gap-fill**, never proof
- The **Evidence store** outlives a **Run**, because a later `create-pr` call still has to
  read and publish what it holds

## Example dialogue

> **Dev:** "Does `verify` still work if I only install `verify`?"
> **Author:** "No — `verify` is a **Suite**. It fans out to the reviewer **Skills**, so those have to be installed too. `catchup` is **Standalone**, that one you can take on its own."
>
> **Dev:** "And it needs Claude Code?"
> **Author:** "It's **Harness-neutral** — it doesn't name a **Harness** anywhere. A **Harness** without sub-agents runs the reviewers one at a time instead of in parallel."

## Flagged ambiguities

- "agent" was used to mean both the **Harness** and a sub-agent it spawns — resolved: the **Harness** is the program; the things it spawns are sub-agents.
- "degrade" was used for running on a less capable **Harness** — rejected as pejorative and inaccurate; the property is **Harness-neutral**, and a **Harness** either supports a feature or runs a documented fallback.
- "state" was used for both the coach's in-context variables and its durable record — resolved: the **Run ledger** is the durable record, and the in-context values are working copies of it that are never authoritative.
