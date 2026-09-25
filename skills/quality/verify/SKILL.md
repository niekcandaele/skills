---
name: verify
description: >
  Run comprehensive triage-first verification pipeline with specialized skills.
  Detects scope, discovers toolchain, triages files to relevant skills, runs static
  analysis, invokes review skills in parallel, exercises the app, and produces a
  unified report. Supports interactive, report-only, and auto-fix modes.
argument-hint: "[--depth=light|deep] [--mode=interactive|report-only|auto-fix] [--scope=staged|unstaged|branch|all] [--base=<ref>] [--files=file1,file2] [--module=path] [--skip-ux] [--skip-visual] [--auto-fix-threshold=N] [--format=markdown|json] [--output=<path>] [--plan-file=<path>] [--epic-context=<path>]"
metadata:
  group: quality
  requires: [reviewer, codex-reviewer, comment-review, qa, tester, ux-reviewer, visual-verify, static-analysis, exerciser, debugger]
---

# Verify Changes — Triage-First Pipeline

## Goal

Run comprehensive verification before considering changes complete. This skill detects what changed, triages files to relevant skills, runs static analysis, invokes review skills in parallel, exercises the app end-to-end, and produces a unified report with actionable findings.

## Phase 0: Parse Arguments & Mode

Parse `$ARGUMENTS` for:

**Mode** (`--mode=`):
- `interactive` (default): Full pipeline → report → interactive triage → plan → fix
- `report-only`: Full pipeline → report → STOP
- `auto-fix`: Full pipeline → report → auto-accept severity >= threshold → plan → fix → STOP

**Depth** (`--depth=`):
- `light` (default): one independent judgement review plus empirical evidence
- `deep`: the full judgement fan-out

**Composition** — what the pipeline runs, by depth:

| | `light` (default) | `deep` |
|---|---|---|
| Triage (Phase 3) | Job A only | Job A + Job B |
| Judgement review | **one**: `codex-reviewer`, or `reviewer` when Codex is unavailable | `reviewer`, `codex-reviewer`, `comment-review`, `qa`, `ux-reviewer` |
| Deterministic | `static-analysis`, `tester` | `static-analysis`, `tester` |
| Empirical | `exerciser`, carrying its own visual lens | `exerciser`, plus `visual-verify` when triage gates it in |
| Diagnostic | `debugger` on failure | `debugger` on failure |
| Plan completeness | when a plan resolves | when a plan resolves |

This table is the single source of truth for composition; callers point here rather than
restating it.

**The two depths are different bets, not different amounts of the same bet.** Deep buys more
lenses on one diff: five reviewers, each with its own specialism, each free to open a line of
inquiry the others would miss. Light buys model diversity and empirical evidence instead: one
review from a genuinely different model where the machine has one, plus starting the
application and actually using the feature. Both keep the checks that cannot wander — a
linter and a test runner report what came back and never widen their own remit.

Light is the default because the caller is usually a model that has already reviewed and
tested its own work. Stacking five more judgement reviewers on top of that does not converge:
each round fixes the previous round's findings, and reviewers meeting a diff that only grew
open new inquiries into code earlier rounds already cleared. Every fix becomes fresh surface
to review.

Deep exists for the change where that cost is worth paying — the integrated result of a whole
epic, an unusually risky diff, a human who asks for it. Ask for it explicitly; nothing selects
it on your behalf.

**Scope Control:**
- `--scope=staged`: Verify only staged changes
- `--scope=unstaged`: Verify only unstaged modified files
- `--scope=branch`: Verify all changes in current branch vs base
- `--scope=all`: Verify entire codebase (comprehensive audit — skips triage, runs all agents on everything)
- `--files="file1,file2"`: Verify specific files only
- `--module=path`: Verify specific module/directory
- Default (no scope arg): Auto-detect from git state
- `--base=<ref>`: Exact baseline ref for `--scope=branch`, for example
  `origin/release`. Reject it with every other scope. Callers that know the PR target must
  pass it; do not replace it with a default-branch guess.

**Other Options:**
- `--skip-ux`: Skip UX review for pure backend changes. **Valid only at `--depth=deep`.** At
  light there is no `ux-reviewer` to skip, so accepting the flag would let a caller believe it
  suppressed something that was never going to run. Reject it as an argument error rather than
  treating it as a no-op.
- `--skip-visual`: Skip visual review for changes the human has already eyeballed (e.g. copy-only). Valid at both depths: at deep it skips `visual-verify`, at light it suppresses the exerciser's visual lens. Visual review is also auto-skipped when `visual-verify` is not among the available skills (defensive — it is normally installed globally, and a project may shadow it with its own copy to customize capture conventions).
- `--auto-fix-threshold=N`: Minimum severity for auto-fix mode (default: 3)
- `--plan-file=<path>`: Explicit path to a plan file for completeness checking. If not provided, discover the plan from context — check if a plan is visible in conversation history (e.g., invoked from player-coach which read a plan, or a plan was created/discussed earlier in this session). If a plan is found from either source, resolve its contents for the plan completeness check in Phase 6.

**Carry-forward across verification runs:**

A caller that runs verification repeatedly against one change — `player-coach` is the
obvious one — can supply what earlier runs already decided. Without it every run is the
first run: fresh reviewers re-audit a diff that only grows, and each round opens a new
line of inquiry into code the previous rounds already cleared. The findings never
converge; they wander.

- `--ledger=<path>`: a run ledger to read (see `player-coach`'s
  `references/run-ledger.md`). Read-only — verify never writes it.
- `--since=<sha>`: the head the last verification run approved. Requires `--ledger`.
  Defines the **delta**.
- `--no-carry-forward`: supply the ledger for reporting but review as though it were the
  first run. This is how the confirming full audit before approval is requested.

With no `--ledger`, verify behaves exactly as it always has, so it stays usable standalone.

**Epic context:**

- `--epic-context=<path>`: a file describing the epic this change is one issue of — what is
  already done, what this issue is, and what is still to come. Read-only, and passed straight
  through to the judgement reviewers. It exists so a reviewer can tell the difference between
  work that was forgotten and work that is scheduled, which is the distinction a reviewer
  looking at one issue of an epic has no way to make on its own.

**Output Format:**
- `--format=`: `markdown` (default) or `json`. When `json`, the report is serialized as a JSON object conforming to the adversary CLI schema (see Phase 8c)
- `--output=<path>`: File path to write the JSON report to. Required when `--format=json`. The Write tool is used to write the file.

## Phase 1: Scope Detection

Determine what files/changes to verify.

**1. Parse User-Specified Scope (if provided):**
- Check `$ARGUMENTS` for `--scope=`, `--files=`, or `--module=` flags
- If specified, use that exact scope
- Skip auto-detection

For explicit branch scope, resolve the comparison before listing files:

```bash
HEAD_SHA=$(git rev-parse HEAD)
BASE_REF="$exact_base_ref" # the parsed --base value, or the resolved default
# Without --base, resolve origin/<provider default branch>; only then fall back to main/master.
BASE_REMOTE=${BASE_REF%%/*}
if git remote get-url "$BASE_REMOTE" >/dev/null 2>&1; then
  BASE_BRANCH=${BASE_REF#*/}
  git fetch "$BASE_REMOTE" \
    "+refs/heads/$BASE_BRANCH:refs/remotes/$BASE_REMOTE/$BASE_BRANCH"
fi
git rev-parse --verify "$BASE_REF^{commit}"
MERGE_BASE=$(git merge-base "$BASE_REF" "$HEAD_SHA")
git diff --name-status "$MERGE_BASE" "$HEAD_SHA"
git diff -U0 "$MERGE_BASE" "$HEAD_SHA" -- "$scoped_file"
```

Set task-specific `exact_base_ref` and `scoped_file` values before running the snippet.

Never compare branch scope to a stale local branch when its `origin/` ref exists. Preserve
`BASE_REF` exactly as supplied in the report, while recording the resolved `MERGE_BASE`
and `HEAD_SHA` separately. An unknown base ref or failed merge-base calculation is a
verification error; silently choosing a different base would verify the wrong change.

**2. Auto-Detect Scope (default behavior):**

Priority order:
1. **Staged changes exist?** → Scope to staged files only
2. **Unstaged changes exist?** → Scope to modified files only
3. **Branch has commits ahead of base?** → Scope to branch changes
4. **No changes detected?** → Report "nothing to verify" and STOP

**Git Commands for Scope Detection:**

```bash
# Check for staged changes
git diff --cached --name-only

# Check for unstaged changes
git diff --name-only

# Check for branch changes
if git remote get-url origin >/dev/null 2>&1; then
  git fetch origin
fi
BASE_REF=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
if [ -z "$BASE_REF" ]; then
  DEFAULT_BRANCH=$(git remote show origin 2>/dev/null | sed -n 's/^[[:space:]]*HEAD branch: //p')
  if [ -n "$DEFAULT_BRANCH" ] &&
     git rev-parse --verify "origin/$DEFAULT_BRANCH^{commit}" >/dev/null 2>&1; then
    BASE_REF="origin/$DEFAULT_BRANCH"
  elif git rev-parse --verify 'origin/main^{commit}' >/dev/null 2>&1; then
    BASE_REF=origin/main
  elif git rev-parse --verify 'origin/master^{commit}' >/dev/null 2>&1; then
    BASE_REF=origin/master
  elif git rev-parse --verify 'main^{commit}' >/dev/null 2>&1; then
    BASE_REF=main
  elif git rev-parse --verify 'master^{commit}' >/dev/null 2>&1; then
    BASE_REF=master
  else
    echo 'No provider default, origin/main, origin/master, main, or master base exists' >&2
    exit 1
  fi
fi
MERGE_BASE=$(git merge-base "$BASE_REF" HEAD)
git diff --name-only "$MERGE_BASE" HEAD

# Get line ranges for changed files
git diff --cached -U0 -- "$scoped_file"  # staged
git diff -U0 -- "$scoped_file"           # unstaged
git diff -U0 "$MERGE_BASE" HEAD -- "$scoped_file" # branch
```

**3. Build Scope Context:**

Create a list of files in scope with status:
- `file.ts` (modified, lines 45-67, 89-102)
- `new-file.ts` (added, entire file)
- `old-file.ts` (deleted)

Store as `SCOPE_CONTEXT` for passing to agents.

Also build a machine-usable `SCOPE_METADATA` block for agents that need exact diff reconstruction:
- `scope_mode`: `staged`, `unstaged`, `branch`, `files`, `module`, `all`, or the resolved auto-detected mode
- `base_ref`: exact baseline ref/commit used for the scoped diff
- `compare_ref`: exact comparison target (`HEAD`, `INDEX`, `WORKTREE`, or explicit ref)
- `path_filter`: exact scoped paths, or `ALL_SCOPED_FILES`
- `diff_command`: exact git diff command used to define the scope
- `merge_base`: exact merge-base hash for branch scope, otherwise empty
- `head_sha`: full `git rev-parse HEAD` SHA for branch scope, otherwise the full HEAD SHA
  observed when verification began
- `included_files`: ordered file/status records admitted to the scope
- `excluded_files`: ordered path/reason records explicitly excluded; use
  `ALL_OTHER_FILES (outside selected scope)` when paths were not enumerated

With `--since=<sha>`, add three more fields describing what changed since the last
verified head. They are **additive**: every field above keeps its meaning and the full
scoped diff is still what reviewers receive.
- `delta_base_sha`: the `--since` value
- `delta_files`: `git diff --name-status $DELTA_BASE $HEAD`
- `delta_hunks`: the same comparison at `-U0`

`SCOPE_METADATA` is the source of truth for any skill that needs to reconstruct the selected diff.

**4. Format Scope for Agents:**

```
VERIFICATION SCOPE:
Files in scope:
- src/auth/login.ts (modified, lines 45-67, 89-102)
- src/auth/middleware.ts (modified, lines 12-34)
- tests/auth/login.test.ts (added, entire file)

CRITICAL SCOPE CONSTRAINTS:
- ONLY flag issues in code that was ADDED or MODIFIED in these files/lines
- DO NOT flag issues in surrounding context or old code unless it blocks the new changes
- DO NOT flag issues in other files not listed above
- Focus exclusively on the quality of the NEW or CHANGED code

Exception: You MAY flag issues in old code IF:
1. The new changes directly interact with or depend on that old code
2. The old code issue is causing the new code to be incorrect
3. The old code issue creates a blocker for the new functionality

Git commands to see your scoped changes:
git diff HEAD -- <scoped-files>
git diff --cached -- <scoped-files>
```

Example machine-readable metadata:
```text
SCOPE_METADATA:
- scope_mode: unstaged
- base_ref: INDEX
- compare_ref: WORKTREE
- path_filter: src/auth/login.ts,src/auth/middleware.ts
- diff_command: git diff -- src/auth/login.ts src/auth/middleware.ts
- merge_base:
- head_sha: 9d8f...full SHA
- included_files: src/auth/login.ts,src/auth/middleware.ts
- excluded_files: ALL_OTHER_FILES (outside selected scope)
```

## Phase 2: Load Engineer Skill

Many repositories carry an **engineer skill** — a `<repo>-engineer` skill that
documents how to build, test, and run that specific repository. Find it two ways,
in this order:

1. Look among the skills available in this session for one whose name ends in
   `-engineer`. This is the reliable check for whether one exists.
2. Locate its directory on disk, because later phases must hand sub-agents a real
   path — a sub-agent cannot resolve a skill by name, and most harnesses expose
   names rather than paths:

```bash
ls -d .*/skills/*-engineer/ */skills/*-engineer/ 2>/dev/null | grep -v '^\.\./'
```

**If one is available:**
- Read its SKILL.md
- Read key reference files it points to (TESTING.md, architecture docs, etc.)
- Extract: test commands, build commands, linter commands, architecture notes
- Store as `ENGINEER_CONTEXT` — this is pre-verified knowledge from `/setup-engineer`
- Store the directory from step 2 as `ENGINEER_SKILL_DIR`. If the skill is loaded
  but the glob found nothing (it lives outside the repository), say so in the
  report and leave `ENGINEER_SKILL_DIR` empty — sub-agents then fall back to the
  summary in `ENGINEER_CONTEXT` instead of reading the files themselves.
- Check for `VERIFICATION.md` in the same skill directory — if it exists, read it and store as `CUSTOM_GATES`
  - Extract **Exerciser Gates** → will be passed to exerciser in Phase 7c
  - Extract **Review Gates** → will be passed to review agents in Phase 5/6
- The discovery phase (Phase 3) will validate these commands and only discover what's missing

**If there is no engineer skill:**
- `ENGINEER_CONTEXT` is empty
- `CUSTOM_GATES` is empty
- `ENGINEER_SKILL_DIR` is empty
- The discovery phase will do full discovery from scratch

## Phase 3: Discovery & Triage

Launch ONE fast, read-only exploration sub-agent with two jobs in a single prompt.

**At `--depth=light`, send Job A only.** Job B produces two things and light consumes
neither: per-skill file assignments, when the single judgement reviewer wants the whole
scoped diff anyway, and the `ux-reviewer` / `visual-verify` gating decision, when neither
skill is in the light composition and the visual lens gates itself on what the exerciser
actually did. Reading every changed file to produce a routing table nobody reads is exactly
the kind of cost light exists to avoid. Job A stays either way — `static-analysis` and
`tester` need `TOOLCHAIN`.
(On Claude Code that is the `Explore` agent type; any read-only sub-agent will do.)

### Job A: Discover Project Toolchain

**If engineer skill exists:** Validate that the provided commands still work and discover anything missing:
```
The engineer skill provides these commands:
- Test: {test_command}
- Build: {build_command}
- Lint: {lint_commands}

Verify each command exists (which/type check). For any that fail, discover alternatives.
Discover any additional linters/type-checkers not covered by the engineer skill.
```

**If no engineer skill:** Full discovery:
```
Discover the project's toolchain:
- Test command (npm test, pytest, cargo test, go test, etc.)
- Build command (npm run build, cargo build, go build, etc.)
- Linter commands (eslint, pylint, clippy, golangci-lint, etc.)
- Type-checker commands (tsc --noEmit, mypy, etc.)

Check package.json scripts, Makefile targets, CI config, pyproject.toml, Cargo.toml, go.mod.
Output concrete commands that can be executed.
```

### Job B: Triage Changed Files

**Deep depth only** — see the note above Job A.

Triage does two things: assign files to focus each skill, and decide whether the two
user-facing skills apply at all.

```
Read each changed file (not just the extension — look at actual content).

ALWAYS-ON SKILLS — these run on every verification, no exceptions.
Assign each the full scoped file list.

- reviewer          Business logic, architecture, patterns, security, robustness,
                    over-engineering. Needs breadth across the whole diff.
- codex-reviewer    General second-opinion pass, not a specialist router target.
- comment-review    Comment rot, verbose rationale, and comment density can appear in any changed file.
- qa                Test coverage assessment for everything that changed.
- tester            Any code change could affect tests.

GATED SKILLS — these run only if the scope contains surfaces they can review.
Decide applies: true/false for each, and state your reason either way.

- ux-reviewer   APPLIES if the scope touches ANY user-facing surface:
                UI components, CLI output or help text, user-facing strings,
                error messages, API response messages, user-visible log output.
                Assign the specific user-facing files.

                SKIP only when ALL of those are absent — pure backend,
                infrastructure, or internal refactoring with no user-visible
                surface whatsoever.

                WHEN IN DOUBT, APPLY. A wasted ux-reviewer run costs tokens;
                a missed one ships a confusing error message to users.

- visual-verify APPLIES if the scope contains UI-rendering files where the change
                affects what a user sees on the rendered page — components
                (.astro, .tsx, .vue, .svelte), pages, layouts, templates, CSS,
                design tokens, public assets the page depends on for rendering.
                Assign those files.

                SKIP if none are present. NOT JSON config, NOT server-side
                handlers without UI side effects, NOT pure copy strings
                (those are ux-reviewer's).

A file can be assigned to multiple skills.

Output a JSON-like mapping:
{
  "skill_assignments": {
    "reviewer": ["all scoped files"],
    "codex-reviewer": ["all scoped files"],
    "comment-review": ["all scoped files"],
    "qa": ["all scoped files"],
    "tester": ["all"],
    "ux-reviewer": ["UI/CLI/user-facing files"],
    "visual-verify": ["UI-rendering files"]
  },
  "gating": {
    "ux-reviewer": { "applies": true,  "reason": "CLI help text modified in src/cli/help.ts" },
    "visual-verify": { "applies": false, "reason": "no UI-rendering files in scope" }
  },
  "toolchain": {
    "test": "npm test",
    "build": "npm run build",
    "lint": ["npx eslint", "npx tsc --noEmit"]
  }
}
```

**Explicit user overrides** force a skip regardless of what triage decided:
- `--skip-ux` → `ux-reviewer` is skipped.
- `--skip-visual` → `visual-verify` is skipped. Use this when you have already eyeballed the rendered change in a browser and want to suppress the duplicate review. Visual review is the design-quality gate, not just a bug check — it asks "would a designer ship this?"

`visual-verify` is also skipped if it is not among the available skills (defensive — it is normally installed globally and always present; a project may shadow it with its own copy to customize capture conventions).

**Output:** Store the skill assignments and gating decisions as `TRIAGE_RESULT` and toolchain commands as `TOOLCHAIN`.

At light, Job B did not run. Set `TRIAGE_RESULT.skill_assignments` to the full scoped file
list for every skill in the light composition, and leave its gating decisions empty. Every
later reference to `TRIAGE_RESULT.skill_assignments` then resolves without branching on depth.

## Phase 4: Static Analysis

Invoke `static-analysis` (a fast, cheap model is enough — it runs commands and reports output) with:
- The scoped file list from Phase 1
- The linter/type-checker commands discovered in Phase 3

```
SCOPED FILES:
{scope file list}

COMMANDS TO RUN:
{each linter/type-checker command from TOOLCHAIN}

Run each command on the scoped files. Parse output into structured findings.
Report only findings in scoped files.
```

Wait for results. Store as `STATIC_SUMMARY`.

## Phase 5: Build Context Bundle

Assemble a compact context bundle (~50-100 lines) for review skills:

```
CONTEXT_BUNDLE:

VERIFICATION SCOPE:
{SCOPE_CONTEXT from Phase 1}

SCOPE METADATA:
{SCOPE_METADATA from Phase 1}

{If --ledger was supplied:}
KNOWN FINDINGS (decided by previous verification runs on this change):

| ID | Location | Title | Root cause | Sev | Disposition | Reason |
|----|----------|-------|------------|-----|-------------|--------|
{one row per ledger finding that is not `fixed`}

DELTA SINCE LAST VERIFIED HEAD: {delta_base_sha}
{delta_files, one per line, with changed line ranges}

{If --epic-context was supplied:}
EPIC CONTEXT:
{the file's contents — completed issues, this issue, remaining issues}

Work whose natural home is one of the remaining issues is deferred, not reported: name it on
a DEFERRED_TO_EPIC line instead of filing a finding. Anything at severity 9-10, anything in
the security class, and any defect this change itself introduces is reported normally
regardless of what the backlog says.

OUTPUT ADDITION:
DEFERRED_TO_EPIC: <issue> — <one sentence>    (or "none")

ENGINEER SKILL SUMMARY:
{Brief summary from ENGINEER_CONTEXT, or "No engineer skill found — toolchain discovered via exploration"}
{If engineer skill exists: "Reference files available at {ENGINEER_SKILL_DIR} — read TESTING.md, ARCHITECTURE.md etc. for your domain"}

STATIC ANALYSIS SUMMARY:
{STATIC_SUMMARY from Phase 4 — just the findings table, not raw output}

TOOLCHAIN:
- Test: {command}
- Build: {command}
- Lint: {commands}

CUSTOM REVIEW GATES:
{Review Gates from VERIFICATION.md, or "None defined"}
These are repo-maintainer-defined requirements. If any rule falls in your review domain,
report PASS/FAIL for it. Failed gates should be reported as severity 9 findings.

DIFF STAT:
{output of: git diff --stat [scope args]}
```

**Keep this compact.** Skills read files themselves — the bundle just tells them where to look and what's already known.

## Phase 6: Launch Review Skills (Parallel)

Invoke the applicable review skills **in parallel** — on Claude Code, a single
message with multiple Skill tool calls.

**If your harness cannot run skills concurrently**, run them one at a time in the
order listed below and concatenate their reports before Phase 7. The pipeline is
correct either way; it is only slower. Do not drop skills to save time — the
report's value comes from the combination.

**If this phase is running one reviewer at a time on a harness that supports
sub-agents, suspect a concurrency cap before suspecting this skill.** Measured on
the Codex CLI: the same fan-out took 359 s of spawn-to-spawn at the default cap
and 43 s once the cap was raised, with no change to these instructions.
**Harness bindings** at the end of this skill records where that cap lives.

### At `--depth=deep`

**Always run, every time:** `reviewer`, `codex-reviewer`, `comment-review`, `qa`, `tester`. Triage focuses these with file assignments but never suppresses them — for correctness-facing review, a missed regression costs more than an extra skill run.

**Run if triage says they apply:** `ux-reviewer` and `visual-verify` (see Phase 3 Job B gating). `--skip-ux` / `--skip-visual` override triage and force a skip.

### At `--depth=light` (default)

**Always run, every time:** `tester`, and exactly **one** judgement reviewer chosen like this:

```bash
which codex
```

On success, invoke `codex-reviewer`. Otherwise invoke `reviewer`. Record which one ran — the
report must say, because a reader cannot otherwise tell what kind of review the change got.

**Never resolve this fallback inside `codex-reviewer`.** That skill's entire value is model
diversity; a substitute review running the same model hidden behind its name would report
`codex-reviewer: COMPLETED` for a pass that had no diversity in it at all. The choice belongs
here, where it is visible in the composition and in the report.

`reviewer` is the more expensive of the two — it is the broadest review in the suite and its
cost tier is the most capable model available. On a machine without Codex, light is one
expensive agent rather than one cheap one. That is still one agent, and it is still the right
substitute: the alternative is a change nobody independently reviewed.

**Never run at light:** `comment-review`, `qa`, `ux-reviewer`, `visual-verify`. These are not
failures or skips-for-cause — they are outside the composition. Phase 7 records them
accordingly.

`exerciser` runs at both depths in Phase 7c, and at light it carries its own visual lens.

**Model routing is the harness's call.** No skill pins a model — the right one
depends on how gnarly the change is, and only the orchestrator knows that. What
each skill needs, as a rough cost signal:

- **Most capable model** — `reviewer`. Comprehensive review across design,
  architecture, coherence, hardening, security, and over-engineering. This is the one
  that benefits most from raw capability.
- **General-purpose model** — `codex-reviewer`, `comment-review`, `qa`,
  `ux-reviewer`, `exerciser`, `visual-verify`. Judgment calls, but bounded ones.
- **Fast, cheap model** — `tester`, `static-analysis`. These run commands and
  report what came back; they are not asked to reason about the result.

**Each skill prompt includes:**
1. The `CONTEXT_BUNDLE` from Phase 5
2. Per-skill file list from `TRIAGE_RESULT.skill_assignments`
3. Static findings relevant to their domain
4. Instruction to read engineer skill reference files for their domain if available
5. Skill-specific instructions (see templates below)

For `codex-reviewer`, `SCOPE_METADATA` is authoritative. It must not infer scope mode from filenames or prose when exact metadata is available.

### Carry-forward rules (only when `--ledger` was supplied without `--no-carry-forward`)

Append this to the prompt of the **judgment** reviewers — `reviewer`, `codex-reviewer`,
`qa`, `comment-review`, `ux-reviewer`, `visual-verify`. Never to `tester`,
`static-analysis`, or `exerciser`: those run commands and report what came back, and a
machine does not drift the way a fresh reader does.

```
CARRY-FORWARD RULES

Tier A — regression lens, full scoped diff, always. You have the whole branch diff and you
review all of it for anything the DELTA broke. A defect the delta introduced or made
reachable is reportable at full severity even at a location listed in KNOWN FINDINGS: an
accepted finding covers the exact state its root cause describes, never the file, the
function, or the subsystem.

Tier B — new audit territory. Do not open a new line of inquiry into code that is unchanged
since DELTA BASE and that KNOWN FINDINGS does not mention. Previous rounds already reviewed
that code against this threshold and dispositioned what they found. Widening the audit a
little further each round is how a loop that was one round from done ends up reporting on a
different subsystem every time.

Matching a known finding:
- Matches a KNOWN finding AND the code there is unchanged since DELTA BASE
  -> do not report it as a finding. List it under REAFFIRMED with the known ID and one sentence.
- Matches a KNOWN finding BUT the code there changed in the delta
  -> report it normally, at full severity. It is a new finding about new code.
- Has new evidence of concrete harm — a failing test, a reproduction, an exploit path
  -> report it normally AND list it under REOPENED with that evidence.

Never suppressible, whatever KNOWN FINDINGS says: anything at severity 9 or 10, and
anything in the security class.

OUTPUT ADDITIONS:
REAFFIRMED: <known id> — <one sentence>    (or "none")
REOPENED:   <known id> — <harm evidence>   (or "none")
```

**The orchestrator never filters.** Do not drop a reported finding because it matches the
ledger. Suppression is a judgement a reviewer makes with the whole diff in front of it, and
every instance of it is visible as a `REAFFIRMED` row. A quiet string-match filter in the
pipeline would be undetectable exactly when it was wrong.

### Skill Prompt Templates

**For each skill, the prompt follows this structure:**

```
{CONTEXT_BUNDLE}

YOUR ASSIGNED FILES:
{files from TRIAGE_RESULT.skill_assignments for this skill}

RELEVANT STATIC FINDINGS:
{filtered findings from STATIC_SUMMARY relevant to this skill's domain}

{If engineer skill exists:}
ENGINEER SKILL REFERENCE:
Reference files are available at {ENGINEER_SKILL_DIR}
Read files relevant to your domain (e.g., TESTING.md for tester, architecture docs for reviewer).

{Skill-specific instructions...}

OUTPUT FORMAT: For each issue found, provide:
- Title (short description)
- Severity (1-10, where 1=trivial, 10=critical)
- Location (file:line)
- Description (what the issue is and why it matters)
```

**Skill-specific instruction blocks:**

**reviewer:**
```
Comprehensive review across all five dimensions:
1. Design & Code Quality: design adherence, over-engineering, AI slop, test integrity, structural completeness
2. Architecture: module boundaries, dependency direction, god objects, abstraction opportunities, coupling
3. Coherence: reinvented wheels, pattern violations, convention mismatches, documentation drift, dead code
4. Hardening: invalid inputs, error paths, inconsistent validation, orphaned references, state transitions
5. Security: injection, auth/authz, multi-tenant isolation, data exposure, crypto

Research the project's structure, patterns, and security approach BEFORE evaluating changes.
Focus on: 'Is this change well-designed, structurally sound, pattern-consistent, robust, and secure?'

Work the over-engineering lens in Dimension 1 deliberately — it is easy to review only
for what is missing and never for what should be cut. Tag those findings
(delete / stdlib / native / yagni / shrink), verify each proposed replacement actually
exists before reporting it, and close the report with the net-lines metric.
```

**codex-reviewer:**
```
Run the local Codex CLI as an independent second-opinion reviewer.
Shell out to the local Codex CLI — the point is a second engine's opinion, not your own analysis again.
Follow the codex-reviewer skill's own execution procedure exactly; it owns the invocation, the completion detection, and the timeout. Do not substitute your own — this prompt is scope and context, not a runbook.
Use `SCOPE_METADATA` as the source of truth for scope reconstruction.
Adapt the verify scope into a temporary diff-only workspace under /tmp so Codex reviews only the intended changes.
Do NOT infer staged vs unstaged vs branch vs path-filtered scope from assigned files or prose if `SCOPE_METADATA` says otherwise.
If exact reconstruction from `SCOPE_METADATA` is not possible, report PATCH_CONSTRUCTION_FAILED instead of reviewing an approximate diff.
If Codex is unavailable (missing CLI, auth missing, network blocked, sandbox blocked), report BLOCKED status with a short factual reason.
If scope is `--scope=all`, report SKIPPED_UNSUPPORTED_SCOPE rather than attempting a whole-codebase audit.
Normalize Codex output into: title, severity, location, description.
```

**comment-review:**
```
Review ONLY comments and docstrings added or modified in the scoped diff
(plus pre-existing comments the changes make stale).
Flag: ephemeral review-ID references (VI-N, CI-N, "per review feedback"),
historical change-narration ("previously", "now we", "replaced X with Y"),
stale comments contradicting the code, reviewer-appeasement, redundant restatement,
verbose rationale that a 1–2 line comment would carry, and one diff-level finding when
added comment lines exceed 10% of added code lines.
Comments must describe the current code and its intent — git owns history.
Code correctness, design, and prose docs are out of scope — other skills own those.
Normalize findings into: title, severity (floor 5, cap 6 — the floor is deliberate),
location, category (tag), description including a concrete rewrite (or "delete").
If comments are clean, report COMPLETED with zero findings.
```

**tester:**
```
Run the full test suite using: {test command from TOOLCHAIN}
Report exact pass/fail counts.
If tests cannot run, report what prevented execution.
For EACH failure: title, severity, location, error message, and whether it's IN-SCOPE or OUT-OF-SCOPE.
```

**ux-reviewer:**
```
ONLY test user-facing changes in the scoped files.
Do not audit the entire UI/CLI for issues.
Focus on the UX of what changed in this scope.
Test any UI, CLI output, error messages, or API responses that were modified.
```

**qa:**
```
Evaluate whether the scoped changes are adequately tested.
Assess test quality, mock usage, and test type appropriateness.
Adapt expectations to codebase testing maturity.
Focus on: 'Are these changes well-tested with good tests?'
```

**visual-verify:** *(only invoked if the skill is present in the available skills list and `--skip-visual` was not passed)*
```
Read the engineer skill for screenshot mechanics (wrapper command, dev URLs, viewport conventions) — typically VISUAL.md or the engineer SKILL.md.
For each UI-rendering file in YOUR ASSIGNED FILES, identify at least one route that renders it (grep imports for components; page files render directly).
Take screenshots at desktop (1440-wide, full-page) AND mobile (390-wide, full-page). If responsive sizing changed, sample boundary widths too.
Open every PNG with `Read` and apply the holistic articulation step described in the skill: write 2-3 sentences describing the composition in designer's terms (balance, weight, hierarchy, rhythm, alignment, density, color, typography). Anything in that paragraph that reads as a complaint becomes a finding.
Focus on: 'Would a designer ship this?' — not 'is anything imperfect?'
If no UI-rendering files in scope or no running app discoverable, return STATUS: SKIPPED with a one-line factual reason — same convention as codex-reviewer.
Output structured findings (Title / Severity / Location / Category / Description) per the skill's reviewer-mode protocol.
```

### Plan Completeness Check (Parallel, Conditional)

This check runs in parallel with the review skills above. It has no dependency on their output — it only needs the plan and the branch diff.

**If a plan was resolved** (via `--plan-file` flag or discovered from conversation context):

Invoke a general-purpose agent with:

```
PLAN FILE:
{plan file contents}

BRANCH DIFF:
{output of the diff command from SCOPE_METADATA, or `git diff {base}...HEAD`}

SCOPE CONTEXT:
{SCOPE_CONTEXT from Phase 1}

You are checking whether the implementation is complete relative to the plan.

Instructions:
- Identify all phases, sections, and steps described in the plan
- For each, determine whether the branch diff contains changes that implement it
- A phase is "addressed" if the diff contains changes that clearly correspond to its requirements
- If significant portions of the plan are unimplemented, emit a single finding:
  - Title: "Plan incomplete — only phase N of M implemented" (or similar descriptive summary)
  - Severity: 8
  - Description: List which phases/sections are implemented and which are missing, with brief reasoning
  - Sources: ["plan-completeness"]
  - Location: null (omit)
- If the plan appears fully implemented, emit NO finding (do not emit a success finding)

OUTPUT FORMAT: For each issue found, provide:
- Title (short description)
- Severity (1-10, where 1=trivial, 10=critical)
- Location (file:line or null)
- Description (what the issue is and why it matters)
```

**If no plan was resolved** (no flag, nothing in context): skip this check entirely, no finding emitted.

## Phase 7: Collect Results + Conditional Agents

### 7a. Wait for all Phase 6 skills to complete

This is one wait covering the whole set, not one wait per skill.

**A skill that produced no result is `NOT_RUN`, never `COMPLETED`.** If it returned
empty, hit a provider quota or rate limit, timed out, or was refused a start,
record `NOT_RUN` with the observed reason. A review that never ran and a review
that found nothing are opposite outcomes, and only one of them is good news —
filing the first as the second turns a hole in the pipeline into a clean bill of
health.

**A skill outside the current depth's composition is `SKIPPED`, never `NOT_RUN`.** Record it
as `SKIPPED` with the reason `not in light composition`. `NOT_RUN` has to keep meaning "this
should have run and did not" — that is the entire point of the rule above, and reusing it for
"this was never part of the plan" would hide a real hole behind an expected one. Running the reviewers concurrently makes quota refusals more likely, not
less, so this distinction earns its keep.

Collect structured findings from each skill. Extract ONLY:
- Title
- Severity (1-10)
- Location (file:line)
- Category (skill-specific)
- Description

**Discard investigation narratives.** Keep the orchestrator context lean.

For `codex-reviewer`, also collect skill status if no findings were produced:
- `COMPLETED`
- `BLOCKED`
- `SKIPPED_UNSUPPORTED_SCOPE`

For `visual-verify`, also collect skill status if no findings were produced:
- `COMPLETED`
- `SKIPPED` with reason (`NO_UI_FILES_IN_SCOPE`, `NO_RUNNING_APP_DISCOVERABLE`, `NO_SCREENSHOT_MECHANISM`). SKIPPED is expected behavior, not a warning — it just means there was nothing visual in scope.

**Codex BLOCKED handling:** If `codex-reviewer` reports BLOCKED, this is a significant event — the independent second-model review did not run. Flag it prominently in the report:
- In `report-only` mode: Include BLOCKED status with high visibility in the Agent Results Summary and add a prominent warning after the summary table.
- In `interactive` mode: Use `AskUserQuestion` to ask: "Codex review was BLOCKED ({reason}). Continue without Codex review, or stop to resolve?"
- `SKIPPED_UNSUPPORTED_SCOPE` is expected for `--scope=all` and is not flagged as a warning.

### 7b. Conditional: debugger

If tester OR exerciser — or, at deep, ux-reviewer — reported failures (severity 7+):

`debugger` runs at both depths. It is a diagnostic that fires on an observed failure, not a
reviewer that goes looking for one, so it cannot widen an audit the way a judgement skill can.
Callers depend on it: `player-coach` can only open a quarantine entry on a debugger
determination, so dropping it at light would silently disable quarantine.

Invoke `debugger` with:
```
VERIFICATION SCOPE CONTEXT:
{SCOPE_CONTEXT}

FAILURES TO INVESTIGATE:
{list of failures from tester/ux/exerciser}

Analyze the root cause of these failures.
Focus on failures caused by the scoped changes.
If failures are unrelated to scope, note that explicitly.

For each failure, determine whether the scoped changes caused it or whether it was already
there. Check out {scope.mergeBase} in a scratch worktree and run the same command against it.
Report, per failure:
  PRE_EXISTING: yes | no | undetermined
  COMMAND: <the exact command you ran>
  EVIDENCE: <output excerpt showing the same failure signature at the merge base>
  TOUCHED_BY_DIFF: <paths in the failure's stack that appear in the scoped diff, or none>
```

That extra suite run costs one execution per distinct failure signature, once. It buys back
far more than it costs: without it, an environment failure that has nothing to do with the
change gets re-diagnosed from scratch on every round it appears in, at full suite price
each time, and gets re-reported at a severity that dominates whatever the round was
actually about.

### 7c. Always: exerciser with issue verification

Runs **after** the Phase 6 reviews, not in parallel with them — it needs the collected issue list as input.

Invoke `exerciser` with:
```
{CONTEXT_BUNDLE}

Exercise the changes end-to-end:
1. Read the engineer skill at {ENGINEER_SKILL_DIR} if one was found — follow its instructions for starting the environment, authenticating, and interacting with services
2. Start the full local environment (app + all backing services)
3. Determine exercise strategy based on change type:
   - Frontend/UI changes → use Playwright to navigate and interact
   - API/backend changes → make actual API calls via curl, verify responses and data state
   - Data/search/indexing changes → trigger operations, query services via CLI tools to verify data was written/indexed
   - Job/worker changes → trigger jobs, verify side effects via database/service queries
   - Mixed → exercise through all affected interfaces
4. Verify data flows end-to-end — don't stop at "endpoint returns 200", follow data through the system
5. Report whether the specific changes actually work with real data

If you hit a barrier (can't start, need credentials, unclear what to test, no engineer skill for complex backend):
- Return BLOCKED status with specific reason
- If you cannot determine HOW to exercise the change, that is severity 9-10

{At --depth=light, and unless --skip-visual was passed:}
VISUAL LENS: ACTIVE
If your exercise path went through rendered UI in a browser, also look at what you rendered
and report visual defects, following your skill's visual lens section. If you exercised the
feature through an API, a CLI, a job, or the database, there is nothing rendered to look at —
say so and move on.

{At --depth=deep:}
VISUAL LENS: INACTIVE — visual-verify owns visual review at this depth. Do not duplicate it.

ISSUES FOUND BY REVIEW SKILLS:
{List of all issues found in Phase 6 with VI-IDs, severity, title, location}

While exercising, attempt to trigger each reported issue and report verification status
(CONFIRMED / NOT REPRODUCED / NOT APPLICABLE / BLOCKED).

{If CUSTOM_GATES has exerciser gates:}
CUSTOM EXERCISER GATES:
{List of exerciser gates from VERIFICATION.md}

These are mandatory repo-maintainer-defined checks. After exercising the feature, you MUST
check each gate and report PASS/FAIL with evidence. Any failing gate means your overall
status cannot be PASSED — use FAILED instead.
```

**Handle exerciser barriers:**
- If BLOCKED with `LOGIN_REQUIRED`, `UNCLEAR_FEATURE`, `NO_EXERCISE_STRATEGY`, `NO_ENGINEER_SKILL`, or `SERVICE_UNAVAILABLE` (interactive/auto-fix modes only):
  1. Use `AskUserQuestion` to get help from the user
  2. Re-invoke exerciser with the user's response
  3. If still blocked, record as final BLOCKED status
- In `report-only` mode: Record BLOCKED status in report without asking user

## Phase 8: Generate Unified Report

### 8a. Issue Deduplication

1. Collect all findings from each skill in structured format (including any plan-completeness finding from Phase 6)
2. Identify duplicates: same file/location, same root cause, same symptom from different angles
3. Merge into single issue: list all source agents, combine descriptions, use highest severity
4. Assign sequential VI-{n} IDs
5. Assign each issue a `class`, since skills only emit it as a hint and callers gate on it:
   `correctness`, `security`, `coverage`, `comment`, `ux`, `visual`, `test-failure`,
   `environment`, `style`, `plan-completeness`. The one boundary worth stating explicitly is
   `coverage` versus `correctness`: `coverage` means the code is believed correct but is
   untested; a test that is *wrong* — asserts nothing, mocks the thing under test, passes
   with the implementation deleted — is `correctness`, because the defect is in the test.
   Callers cap repeated `coverage` findings and never cap `correctness`, so when in doubt
   between the two it is `correctness`.
6. Sort by severity descending

**Never re-rate `comment-review` findings downward during dedup.** Its 5-6 severities are a
deliberate floor, not an assessment — they correct a reproducible bias where comment
findings get rated low and then skipped for being low. Merging one into a lower-severity
issue, or "contextualizing" it next to real correctness bugs, reintroduces exactly the
bias the floor exists to cancel.

### 8b. Report Format

```markdown
# Verification Report

## Scope

**Depth:** [light / deep]
**Mode:** [staged / unstaged / branch / all / files / module]
**Base ref:** [exact `--base` value or resolved base; `null` outside branch scope]
**Merge base:** [full SHA or `null` outside branch scope]
**HEAD:** [full SHA observed when verification began]

**Files Verified:**
- src/auth/login.ts (modified, lines 45-67, 89-102)
- src/auth/middleware.ts (modified, lines 12-34)
- tests/auth/login.test.ts (added, entire file)

**Files Excluded:** [ordered paths with reasons, or "All other files (outside selected scope)"]

---

## Triage Summary

**Skills run:** reviewer, codex-reviewer, comment-review, tester, qa, ux-reviewer, visual-verify, exerciser
**Skills skipped:** [none, or each skipped skill with its reason — `visual-verify (gated: no UI-rendering files in scope)`, `ux-reviewer (--skip-ux)`, `visual-verify (not present in available skills)`, `qa (not in light composition)`]
**Judgement reviewer:** [at light: `codex-reviewer` or `reviewer (Codex unavailable)`; at deep: `all five`]
**Static analysis:** ESLint (3 findings), tsc (1 finding)

A gated skip must always name its reason. A mis-gate is only correctable if it is visible in the report.

At light the reviewer line is not decoration. `codex-reviewer` and `reviewer` are different
models looking for different things, and a reader deciding how much to trust this report needs
to know which one they got.

---

## Skill Results Summary

| Skill | Status | Notes |
|-------|--------|-------|
| static-analysis | Completed | 4 findings (3 warnings, 1 error) |
| tester | X passed, Y failed | [brief note] |
| reviewer | Completed | Found N items (design, arch, coherence, hardening, security; net -N lines possible) |
| codex-reviewer | Completed / **BLOCKED** / Skipped | Found N items / [reason] |
| comment-review | Completed | Found N items / Comments clean |
| qa | Completed | Found N items |
| ux-reviewer | Completed / Skipped | Found N items / [gating or override reason] |
| visual-verify | Completed / Skipped / Not Available | Found N items / [gating or override reason] |
| exerciser | PASSED / FAILED / BLOCKED | [reason if blocked] |
| plan-completeness | Complete / Incomplete / Skipped | [summary if incomplete, reason if skipped] |
| debugger | Ran / N/A | [if applicable] |

---

## Issues Found

[Deduplicated issues from all agents, sorted by severity descending]

| ID | Sev | Title | Sources | Location | Description |
|----|-----|-------|---------|----------|-------------|
| VI-1 | 9 | [Short title] | tester, reviewer | file:line | [Combined description] |
| VI-2 | 7 | [Short title] | security | file:line | [Description] |

*Severity: 9-10 Critical | 7-8 High | 5-6 Moderate | 3-4 Low | 1-2 Trivial*
*Sources column shows which agents flagged the issue. Multiple sources = higher confidence.*

**Total: N issues from M skill findings (deduplicated)**

---

## Deferred to Later Epic Issues

{Omit this section entirely when no --epic-context was supplied or nothing was deferred}

| Issue | Deferred item | Reported by |
|---|---|---|
| #47 | export endpoint has no pagination | reviewer |

These are not findings and never block. They are recorded so a deferral is visible and
correctable — a suppression nobody can see is only ever discovered by being wrong.

---

## Exerciser Verification

| Issue ID | Title | Exerciser Status | Notes |
|----------|-------|-----------------|-------|
| VI-1 | [title] | CONFIRMED | [observation] |
| VI-2 | [title] | NOT REPRODUCED | [what was tried] |
| VI-3 | [title] | NOT APPLICABLE | [reason] |

---

## Custom Verification Gates

{If no VERIFICATION.md exists or no custom gates defined: omit this section entirely}

### Exerciser Gates
| # | Rule | Status | Evidence |
|---|------|--------|----------|
| 1 | [rule from VERIFICATION.md] | PASS / FAIL / BLOCKED | [from exerciser report] |

### Review Gates
| # | Rule | Status | Checked By | Evidence |
|---|------|--------|------------|----------|
| 1 | [rule from VERIFICATION.md] | PASS / FAIL / NOT CHECKED | [skill name] | [from skill findings] |

**Custom Gates: X/Y passed, Z blocked**
```

### 8c. JSON Output (`--format=json --output=<path>`)

When both flags are set, serialize the same deduplicated data used by the Markdown report.
JSON v1 has a complete trace-facing shape while retaining the adversary contract:
`schemaVersion`, `status`, and `findings` keep their existing names and meanings.

**Step 1 — Determine `status`:**

| Condition (checked in order) | `status` |
|------------------------------|----------|
| Verify crashed or could not execute (skill invocation failure, invalid base, internal error) | `"error"` |
| Verify could not produce meaningful analysis (for example no toolchain and no review skill could run) | `"blocked"` |
| The pipeline completed, including when it found code/test failures | `"ok"` |

Build/typecheck errors and test failures are findings with severity 9–10, not terminal
schema statuses. `blocked` means verification itself could not provide meaningful analysis.

**Step 2 — Normalize locations once, then project both contracts:**

Parse a textual location into this structured issue location:

```json
{
  "path": "path/to/file.js",
  "line": 27,
  "endLine": 36
}
```

Split a textual location on the last colon followed by a line or line range. Omit
`endLine` for a single line. Project `issues[].location` from the full structured object.
Project the stable adversary `findings[].location` as exactly `{"path": ..., "line": ...}`;
never add `endLine` there. Omit `findings[].location` when none applies and set
`issues[].location` to `null`. Never substitute an empty object or a prose location.

**Step 3 — Assemble exactly this shape:**

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "error": null,
  "findings": [
    {
      "title": "Issue title",
      "severity": 8,
      "description": "Why this matters",
      "sources": ["reviewer", "tester"],
      "location": {"path": "src/example.ts", "line": 27}
    }
  ],
  "overall": {"result": "issues-found", "mode": "branch"},
  "scope": {
    "depth": "light",
    "mode": "branch",
    "baseRef": "origin/release",
    "mergeBase": "0123456789abcdef0123456789abcdef01234567",
    "headSha": "89abcdef0123456789abcdef0123456789abcdef",
    "includedFiles": [
      {"path": "src/example.ts", "status": "modified", "lines": ["27-36"]}
    ],
    "excludedFiles": [
      {"path": "ALL_OTHER_FILES", "reason": "outside selected scope"}
    ],
    "files": [
      {"path": "src/example.ts", "status": "modified", "lines": ["27-36"]}
    ],
    "excluded": [
      {"path": "ALL_OTHER_FILES", "reason": "outside selected scope"}
    ],
    "deltaBaseSha": null,
    "deltaFiles": []
  },
  "knownFindings": null,
  "deferredToEpic": [],
  "triage": {
    "skillsRun": [
      {"skill": "reviewer", "reason": "code files require correctness review"},
      {"skill": "tester", "reason": "test command discovered"},
      {"skill": "exerciser", "reason": "user-visible flow changed"}
    ],
    "skillsSkipped": [
      {"skill": "visual-verify", "reason": "no UI-rendering files in scope"}
    ],
    "skills_run": ["reviewer", "tester", "exerciser"],
    "skills_skipped": ["visual-verify"]
  },
  "skillResults": [
    {"skill": "reviewer", "status": "COMPLETED", "notes": "Judgement reviewer at light depth (Codex unavailable). Found 1 item"},
    {"skill": "qa", "status": "SKIPPED", "notes": "not in light composition"},
    {"skill": "exerciser", "status": "PASSED", "notes": "Flow completed; visual lens active, 0 visual findings"}
  ],
  "issues": [
    {
      "id": "VI-1",
      "severity": 8,
      "title": "Issue title",
      "sources": ["reviewer", "tester"],
      "location": {"path": "src/example.ts", "line": 27, "endLine": 36},
      "description": "Why this matters"
    }
  ],
  "exerciserVerification": [
    {"issue": "VI-1", "status": "CONFIRMED", "evidence": "Observed during save"}
  ],
  "customGates": {
    "exerciser": [
      {"rule": "Saved records can be reloaded", "status": "PASS", "evidence": "Reloaded record 42", "checker": "exerciser"}
    ],
    "review": [
      {"rule": "Tenant queries remain scoped", "status": "PASS", "evidence": "Reviewed query predicate", "checker": "reviewer"}
    ]
  }
}
```

Field rules:

- `overall.result` is `error` when `status` is `error`, `blocked` when `status` is
  `blocked`, `issues-found` when `status` is `ok` with one or more issues, and `pass` when
  `status` is `ok` with no issues. These are its only values.
- `error` is `null` for `ok`/`blocked`, and an object with stable `code` and factual
  `message` for `status: error`.
- `scope.depth` is `light` or `deep`, always present. A report that does not say how hard it
  looked cannot be interpreted later, and light and deep reports will be compared against each
  other.
- `scope.mode` is the resolved scope mode. `baseRef` is a string only for branch scope and
  `null` otherwise. `mergeBase` is the resolved full SHA for successful branch scope,
  `null` outside branch scope, and also `null` when an invalid base prevents resolution.
  `headSha` is always the full SHA observed at start.
  `includedFiles` and `excludedFiles` are ordered and never omitted. Retain legacy aliases
  `files` and `excluded` with the same ordered records.
- `triage.skillsRun` lists every invoked skill in invocation order as `skill`/`reason`
  objects. `triage.skillsSkipped` contains the same shape for every skipped or unavailable
  skill. Every entry has a factual routing reason.
  Retain `skills_run` and `skills_skipped` as ordered name-only aliases for consumers of the
  earlier partial report.
- `skillResults` is an array, including static analysis, plan completeness, conditional
  debugger, and every run or skipped review skill. Each item has exactly `skill`, `status`,
  and `notes`; `notes` may be an empty string. Normalize `status` to `COMPLETED`, `PASSED`,
  `FAILED`, `BLOCKED`, `SKIPPED`, or `NOT_RUN`; put counts and provider-specific detail in
  `notes`. Exerciser uses `PASSED`/`FAILED`/`BLOCKED`, and Codex uses
  `COMPLETED`/`BLOCKED`/`SKIPPED`, so callers can apply gates by exact value.
- `issues` retains the assigned VI ID and structured location. `findings` mirrors each
  issue without its ID so existing adversary consumers continue to work unchanged.
- `exerciserVerification` contains one entry per issue the exerciser evaluated. `issue`
  is the VI ID, `status` is `CONFIRMED`, `NOT_REPRODUCED`, `NOT_APPLICABLE`, or `BLOCKED`,
  and `evidence` is always present.
- `customGates.exerciser` and `customGates.review` are always arrays, even when empty.
  Every gate records its rule, status, evidence, and the skill or command in `checker`.
- `deferredToEpic` is `[]` with no `--epic-context` and otherwise holds one
  `{"issue": …, "item": …, "source": …}` record per deferral. It is never merged into
  `findings` or `issues`: a deferral is the absence of a finding, and a consumer that gates on
  severity must not see it.
- `scope.deltaBaseSha` and `scope.deltaFiles` describe the delta when `--since` was given;
  `deltaBaseSha` is `null` and `deltaFiles` is `[]` otherwise.
- `knownFindings` is `null` when no ledger was supplied. Otherwise it records what the
  carry-forward rules produced:

```json
"knownFindings": {
  "supplied": 14,
  "reaffirmed": [{"id": "F-3", "skill": "reviewer", "reason": "unchanged since delta base", "newHarmEvidence": false}],
  "reopened": [{"id": "F-7", "skill": "tester", "reason": "now reproduces", "evidence": "…"}]
}
```

  These are additive keys. A consumer that ignores unknown fields is unaffected, which is
  why they do not bump `schemaVersion`. `scope.depth` is additive for the same reason.

The JSON-v1 compatibility boundary is deliberate: `schemaVersion`, `status`, and `findings`
retain their prior meanings and shapes, as required by adversary consumers. The formerly
placeholder-only `skillResults` and `issues.location` shapes are now the defined array and
structured location contracts above; do not weaken those new contracts to imitate an
undocumented placeholder object or prose location. The non-conflicting scope/triage aliases
remain for migration convenience.

Validate the assembled object as JSON, pretty-print it with two-space indentation, and
write it to the exact `--output` path. Never reuse or overwrite a previous verification
run's output file; callers supply a unique path for each invocation.

When an invalid/missing base or merge-base failure produces `status: error`, still emit the
complete v1 shape: preserve the requested `scope.baseRef`, set `scope.mergeBase` to `null`,
use empty included/excluded arrays when file discovery never began, mark unrun skills
`NOT_RUN` with reasons, and populate `error`. This makes the failure parseable without
pretending a merge base exists.

## Phase 9: Mode-Specific Post-Report

### Mode: `report-only`

Output the report and return control to the caller. Do not triage, plan, or fix anything.

- No user prompts — do not use `AskUserQuestion`
- Skip triage/fix phases entirely
- After outputting the report, the verify execution is complete — the caller continues its own flow

**If `--format=json` and `--output=<path>` are set:**
- Phase 8c already wrote the JSON file — the file IS the report
- Output a single confirmation line: `JSON report written to <path>` (no markdown report)
- Return control to the caller

**Otherwise (default markdown):**
- The markdown report is the only output

### Mode: `interactive` (default)

After presenting the report, run interactive triage:

**If zero issues found:** Output the report and return. No triage needed.

**Interactive Triage Process:**

1. Present ALL issues in batches of up to 4 using `AskUserQuestion`
2. Issues sorted by descending severity (most severe first)
3. For each issue: read source file, generate 2-3 specific fix proposals + Explain + Skip
4. Record user decisions

**AskUserQuestion Format (batch of up to 4):**

```
AskUserQuestion:
  questions:
    - header: "VI-1"
      question: "{Title} — {Description}. Found at {file:line} by: {sources} (severity {N})"
      multiSelect: false
      options:
        - label: "{Fix option 1}"
          description: "{Specific action with file:line reference}"
        - label: "{Fix option 2}"
          description: "{Alternative action with file:line reference}"
        - label: "Explain"
          description: "Get the full picture before deciding"
        - label: "Skip"
          description: "Accept this issue — will not fix in this change set"
```

**Handling "Explain":** Read surrounding code, re-present with richer context (alone, not batched). Keep all fix options. If Explain again, dig deeper.

**CRITICAL: Present EVERY issue.** Never skip issues. Only stop early if the user explicitly says "stop", "done", or "skip the rest".

5. After all issues triaged, show triage decision summary table
6. If fixes to apply:
   - Call `EnterPlanMode`
   - Read ALL affected files, analyze dependencies between fixes
   - Write implementation plan to plan file
   - Call `ExitPlanMode` for approval
7. Execute approved fixes in planned order
8. Show completion summary
9. Return control to caller — do not auto-re-run verify or commit

### Mode: `auto-fix`

After presenting the report:

1. Auto-accept all issues with severity >= `--auto-fix-threshold` (default: 3)
2. Skip issues below threshold (noted in summary but not acted on)
3. No user prompts — do not use `AskUserQuestion`
4. Enter plan mode, analyze fixes, write plan
5. Execute fixes
6. Show completion summary
7. Return control (do NOT stop — the caller continues)
8. Do NOT commit

## CRITICAL: No Hiding Issues

The report must be brutally honest:

- Tests should ALWAYS pass — 100% pass rate is the only acceptable outcome
- Tests should ALWAYS be able to run — any setup/environment issue is a bug
- Be transparent — show ALL issues prominently
- Report facts — let humans decide what to act on

### Severity Scale (1-10)

| Range | Impact | Examples |
|-------|--------|----------|
| 9-10 | Critical | Data loss, security vulnerability, cannot function |
| 7-8 | High | Major functionality broken, significant problems |
| 5-6 | Moderate | Clear issues, workarounds exist |
| 3-4 | Low | Minor issues, slight inconvenience |
| 1-2 | Trivial | Polish, cosmetic, optional improvements |

Severity reflects "how big is this issue?" — NOT "must you fix it?" The human decides what to act on.

## Context Window Discipline

This is critical since verify runs in the main context window.

- **Orchestrator stays lean**: Parse args, run git commands, apply triage, invoke skills, collect structured results, format report. No file reading beyond scope detection.
- **Skills do the heavy work**: Each helper skill has its own context window. They read files, grep, investigate.
- **Structured extraction only**: When collecting skill results, extract ONLY: title, severity, location, category, description. Discard investigation narratives.
- **No full file reads in orchestrator**: Never read source files except during the fix execution phase (interactive/auto-fix modes).
- **Compact context bundle**: Scope + static summary + diff stat. ~50-100 lines max.

## Harness bindings

The pipeline above is harness-neutral. These are the mechanisms it maps onto. On
a third harness, add a column and leave everything else alone.

The reason this table exists is that the second column was missing for a long
time, and its absence was invisible: the pipeline still produced a correct
report, just eight times slower. A capability with no stated binding does not
fail loudly — it quietly takes whichever fallback the skill offers.

| Capability | Claude Code | Codex CLI |
|---|---|---|
| Start a sub-agent without blocking | one `Skill` or `Agent` call per skill, all in one message | `spawn_agent`, one per turn; returns a handle in well under a second |
| Wait for the whole outstanding set | implicit — the harness returns when they finish | one `wait_agent` with a multi-minute `timeout_ms`, re-issued only after it returns |
| Cap on simultaneously active sub-agents | none encountered in practice | `features.multi_agent_v2.max_concurrent_threads_per_session`, default 4, counting every active ancestor including this agent. A refused start reports `agent thread limit reached` |
| Read-only exploration sub-agent (Phase 3) | the `Explore` agent type | `spawn_agent` with a read-only sandbox |
| Hand a sub-agent a specific skill | the `Skill` tool by name | name the skill's `SKILL.md` absolute path in the spawned agent's message; the session's skill inventory lists that path |
| Choose a model or effort per sub-agent | `model` on the call, or the skill's frontmatter | `model` / `reasoning_effort` on `spawn_agent` |
| Ask the human a question (Phase 7c, Phase 9) | `AskUserQuestion` | a final-channel question; with no human attached, run `--mode=report-only` instead |
| Enter and exit a reviewed plan before fixing | `EnterPlanMode` / `ExitPlanMode` | present the plan in the final channel and wait for the reply |
| Write the JSON report to a path | the `Write` tool | `apply_patch`, or a shell redirect |

**A cap below the number of applicable skills is a configuration problem, not a
pipeline problem.** Phase 6 degrades correctly when it hits one, but the fix
belongs wherever that harness is configured — and because the cap counts
ancestors, the number that matters is the depth of the whole tree this `verify`
is running inside, not what `verify` alone would like.

The number of applicable skills is itself depth-dependent: light fans out to a handful and is
unlikely to meet a cap at all, while deep is where a low cap turns a parallel phase into a
serial one. A cap that never bites at light can still be badly wrong for deep.
