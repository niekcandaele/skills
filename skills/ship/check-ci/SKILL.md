---
name: check-ci
description: Monitor CI/CD pipeline status after pushes and investigate failures.
argument-hint: '[optional: commit-sha or branch] [--pr=<reference>] [--once]'
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - Skill
metadata:
  group: ship
  requires: [debugger]
---

# Check CI Status and Investigate Failures

## Goal

Monitor CI/CD pipeline status after pushing commits. When failures occur, delegate to the `debugger` skill for systematic investigation and evidence-based root cause analysis.

## Input

Optional commit reference: $ARGUMENTS (e.g., `HEAD`, `abc1234`, `feature-branch`)
- Defaults to the latest commit on the current branch if not specified
- `--pr=<reference>` — inspect this exact PR/MR for its target, head, policy, and
  mergeability; lifecycle callers must supply it
- `--once` — take a single reading and return immediately, without waiting

Resolve `PR_REFERENCE` from `--pr` or, when omitted, the open change for the current
branch. Normalize a URL through the provider into its numeric number/IID before provider
CLI calls. When both a commit reference and a PR/MR are present, their full head SHAs must
match; otherwise return `CI: BLOCKED` with both observed values.

When no open PR/MR exists, preserve standalone behavior: resolve the exact commit SHA, the
canonical provider repository associated with its configured remote, and that repository's
default branch as `TARGET`. Read the default target's required/strict policy and exact-SHA
checks with the same affirmative predicate. Set `MERGEABLE: not-applicable` and
`REVIEW_REQUIREMENTS: not-required`; these fields do not pretend a change request exists.
If the repository/default target is ambiguous, policy cannot be read, or configuration
proves a required check only runs for a PR/MR, return `CI: BLOCKED` rather than guessing or
polling forever.

## `--once`: single-reading mode

Take one reading of CI status, report it, and return. Do not watch, do not sleep, do not
poll. Resolve the full head SHA, the PR/MR target, and the target branch's required-check
policy through the authenticated CI/forge provider. Compare that complete required set to
the checks reported for the exact head; a rollup containing no failures is not proof that a
required check has reported.

Output exactly one status line:

```
CI: PENDING  — <n> running, <n> queued, <n> completed
CI: PASSED   — <n>/<n> required checks successful; <n> optional checks terminal/non-failing
CI: FAILED   — <failing check names>
CI: NONE     — no CI configuration detected for this commit
CI: BLOCKED  — required-check policy or exact-head status cannot be observed
```

Choose it in this order: unobservable exact-head/policy evidence is `BLOCKED`; no CI
configuration is `NONE`; any terminal failing required or optional check is `FAILED`;
missing/running/queued checks or a strict stale target are `PENDING`; only the complete
predicate below is `PASSED`.

Then output this proof block for every result:

```text
HEAD_SHA: <full SHA>
TARGET: <target branch or none>
TARGET_SHA: <full target-tip SHA or none>
REQUIRED_CHECKS: complete | pending (<identities>) | failed (<identities>) | none-configured | unknown (<reason>)
STRICT_POLICY: required | not-required | unknown (<reason>)
UP_TO_DATE: yes | no | not-required | unknown (<reason>)
CHECKS_JSON: [{"name":"<exact name>","source":"<app or pipeline>","identity":"<provider-stable context/app identity>","required":true,"status":"<conclusion or pending>"}]
MERGEABLE: yes | no (<reason>) | unknown (<reason>) | not-applicable
REVIEW_REQUIREMENTS: satisfied | pending (<requirements>) | not-required | unknown (<reason>)
```

`PASSED` requires all of these:

1. At least one CI check or pipeline is configured for the exact head.
2. Every check required by the target policy appears in the result with a terminal
   conclusion.
3. Every required conclusion is successful.
4. Every reported non-required check is terminal and non-failing; `skipped` and `neutral`
   are acceptable only here.
5. When the target policy requires a strict/up-to-date branch, the approved head includes
   the current target tip.

An absent required check is `PENDING`, not success. An unreadable branch policy, provider
that cannot enumerate required checks, or head mismatch is `BLOCKED`. Callers may wait on
`PENDING`; they must never treat `NONE` or `BLOCKED` as green.

Before waiting on a required check that has never reported for a draft, inspect CI trigger
eligibility. If provider configuration or workflow rules prove the check starts only after
ready-for-review or explicitly excludes drafts, return
`CI: BLOCKED — draft suppresses required CI` immediately. Do not poll a state that cannot
change while the suite's draft-first contract is in force. Player-coach preserves the draft
and terminalizes with this evidence; it never marks ready merely to trigger CI.

When strict/up-to-date policy applies and the head does not include the current target tip,
emit `CI: PENDING — target update required` with `UP_TO_DATE: no`. This is distinct from
running checks so orchestration can send the stale target back as fixable feedback.

This suite deliberately applies a stricter conclusion rule than providers that sometimes
allow a required check to conclude `skipped` or `neutral`: only success satisfies a
required check. `REQUIRED_CHECKS: complete` includes the zero-required case when other CI
is configured; `none-configured` accompanies `CI: NONE` only.

When the head belongs to an open PR/MR, inspect mergeability in the same provider read and
populate `MERGEABLE`. This field does not change the CI status itself; callers promising a
mergeable PR require `MERGEABLE: yes` in addition to `CI: PASSED`.

`MERGEABLE` answers whether the exact source can integrate with the target without a code
conflict or stale-head violation. Draft state and pending human approvals do not make CI or
that code-level mergeability non-green; report them separately in `REVIEW_REQUIREMENTS`.
Readiness callers may proceed with pending review. Merge callers require review
requirements to be `satisfied` or `not-required` immediately before merge.

`PENDING` is a normal, expected answer — return it and stop. Do **not** launch `debugger`
on a pending pipeline; investigation is only for a terminal `FAILED`. `BLOCKED` is a
provider-observability failure, not a code failure, so report its evidence without launching
`debugger`.

This mode exists for callers that are managing several pieces of work at once. Watching a
pipeline means holding the session hostage for as long as CI takes, which on a thoroughly
instrumented project can be an hour — time the caller could spend on other work. A caller
that owns its own scheduling wants a cheap reading it can take whenever it likes, not a
blocking wait. Everything below this section describes the default watching mode.

The default watcher uses the same exact-head required-policy binding and the same `PASSED`
predicate. It polls while checks are running or queued. `PENDING — target update required`
is actionable rather than temporal, so return it immediately instead of polling; its
caller must incorporate the target and produce a new head. Investigate `FAILED`, and report
`NONE` or `BLOCKED` without calling either green. After its terminal or actionable reading
emit the same status line and complete proof block defined above. Watching changes timing,
not truth.

## Process

1. **Identify Recent Commits:** Get the latest commit(s) to check CI status for
2. **Detect CI Platform:** Identify which CI/CD system is in use
3. **Monitor CI Status:** Poll for CI pipeline completion with real-time updates
4. **Handle Results:**
   - If success → Present success summary
   - If failure → Launch `debugger` to investigate
5. **Present Report:** Show the skill's investigation findings or success status

## CI Platform Detection

The command automatically detects the CI/CD platform by examining configuration files:

### Detection Priority

1. **GitHub Actions**
   - Check for `.github/workflows/*.yml` or `.github/workflows/*.yaml`
   - Use `gh` CLI for API access
   - Parse workflow runs and job logs

2. **GitLab CI**
   - Check for `.gitlab-ci.yml`
   - Use `glab` CLI for API access
   - Parse pipeline and job logs

3. **CircleCI**
   - Check for `.circleci/config.yml`
   - Use CircleCI API with detected tokens

4. **Jenkins**
   - Check for `Jenkinsfile` or `.jenkins`
   - Use Jenkins API if URL is configured

5. **Travis CI**
   - Check for `.travis.yml`
   - Use Travis API with authentication

6. **Azure DevOps**
   - Check for `azure-pipelines.yml`
   - Use Azure CLI if available

### Required-check policy binding

Configuration files identify the CI system; the authenticated provider identifies what is
required to merge the target branch. Resolve both before emitting `PASSED`.

Without a PR/MR, resolve the provider repository from the exact commit's configured remote
and query its default branch. GitHub uses the same branch rules plus paginated check-runs and
statuses for `HEAD_SHA`, omitting only PR review/mergeability reads. GitLab enumerates every
pipeline whose SHA equals `HEAD_SHA`, its jobs and project/default-branch policy, omitting
MR-only status/approval reads. Multiple exact-SHA pipelines all contribute checks; a
different ref's latest pipeline is never a substitute.

**GitHub:** resolve the canonical base repository from the explicitly selected PR rather
than the checkout's `origin`, then inspect its `headRefOid`, `baseRefName`, and
`statusCheckRollup`. Query both classic branch protection required status checks and rules
applicable to the target branch. Preserve context plus app/integration identity when the
policy supplies it; do not satisfy one provider's required check with another provider's
same-named result. Resolve strict/up-to-date policy and the current target-tip SHA as part
of the same proof. When strict policy applies, require both provider merge state not to be
`BEHIND` and a compare result proving the target-tip SHA is an ancestor of (or identical to)
the exact head; a green check rollup alone is insufficient. A 404 proving no policy exists
is different from an authorization/API failure. URL-encode branch names before inserting
them in API paths.

Normalize GitHub retries before applying the predicate. Group check runs by stable check
identity: name plus app ID, extended only by a provider field documented as stable for the
same logical check across retries. Never use a per-run `external_id`, suite ID, or workflow
run ID as that extension. When GitHub Actions exposes a linked `run_attempt`, prefer its
greatest value; otherwise select the latest `completed_at`/`started_at`, then the greatest
provider ID. If independent same-name checks from one app cannot be distinguished by a
stable key, return `CI: BLOCKED` rather than guessing. Group commit statuses by context plus
creator/app identity and select the newest provider record by `created_at`, then ID; do not
rely only on endpoint ordering. Only these selected records enter `CHECKS_JSON` or
required-check evaluation. Retain superseded records as audit notes, but a superseded
failure cannot fail an exact head after a successful rerun. If two records remain equally
current with conflicting states, return `CI: BLOCKED`. Match branch policy to the same
stable context/app identity, never merely to a display name.

```bash
TARGET_BRANCH_ENCODED=$(jq -rn --arg value "$TARGET_BRANCH" '$value|@uri')
# BASE_REPOSITORY is the provider-scoped canonical base selected from PR_REFERENCE;
# BASE_REPOSITORY_PATH is its OWNER/REPO portion for REST paths.
gh -R "$BASE_REPOSITORY" pr view "$PR_REFERENCE" \
  --json headRefOid,baseRefName,isDraft,statusCheckRollup,mergeable,mergeStateStatus,reviewDecision
gh api --hostname "$BASE_HOST" \
  "repos/$BASE_REPOSITORY_PATH/branches/$TARGET_BRANCH_ENCODED/protection/required_status_checks"
gh api --hostname "$BASE_HOST" --paginate \
  "repos/$BASE_REPOSITORY_PATH/rules/branches/$TARGET_BRANCH_ENCODED"
TARGET_REF_JSON=$(gh api --hostname "$BASE_HOST" \
  "repos/$BASE_REPOSITORY_PATH/git/ref/heads/$TARGET_BRANCH_ENCODED")
TARGET_SHA=$(echo "$TARGET_REF_JSON" | jq -er .object.sha)
COMPARE_STATUS=$(gh api --hostname "$BASE_HOST" \
  "repos/$BASE_REPOSITORY_PATH/compare/$TARGET_SHA...$HEAD_SHA" --jq .status)
case "$COMPARE_STATUS" in ahead|identical) UP_TO_DATE=yes ;; behind|diverged) UP_TO_DATE=no ;; *) exit 1 ;; esac
gh api --hostname "$BASE_HOST" --paginate -H 'Accept: application/vnd.github+json' \
  "repos/$BASE_REPOSITORY_PATH/commits/$HEAD_SHA/check-runs?per_page=100"
gh api --hostname "$BASE_HOST" --paginate \
  "repos/$BASE_REPOSITORY_PATH/commits/$HEAD_SHA/statuses?per_page=100"
```

**GitLab:** resolve the canonical target project from the explicitly selected MR rather than
the checkout's `origin`, then inspect its exact head pipeline, project merge/pipeline policy,
target protected-branch settings, external status checks, detailed merge status,
and approval state. Require the MR `diff_refs.head_sha`, selected pipeline SHA, and requested
`HEAD_SHA` to agree. Select the pipeline by the MR's `head_pipeline.id`, never merely the
latest pipeline. Preserve each job's provider-stable pipeline/job identity. A pipeline is
complete only when all non-optional jobs are terminal. Treat checking, CI pending, a target
that must be incorporated, or a source conflict as non-green; report draft and pending
approvals only in `REVIEW_REQUIREMENTS`. If project policy or external-status requirements
cannot be enumerated, return `BLOCKED` rather than assuming none. URL-encode branch names
before inserting them in API paths.

```bash
TARGET_BRANCH_ENCODED=$(jq -rn --arg value "$TARGET_BRANCH" '$value|@uri')
# Resolve BASE_SELECTOR from the explicit MR URL's project, or from the configured provider
# repository/remote for number, branch, and standalone calls.
BASE_PROJECT_JSON=$(glab -R "$BASE_SELECTOR" repo view --output json)
BASE_REPOSITORY_URL=$(echo "$BASE_PROJECT_JSON" | jq -er .web_url)
BASE_HOST=$(echo "$BASE_REPOSITORY_URL" \
  | sed -E 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^/]+)/.*#\1#')
BASE_REPOSITORY_PATH=$(echo "$BASE_PROJECT_JSON" \
  | jq -er '.path_with_namespace // .full_path')
BASE_PROJECT_PATH_ENCODED=$(jq -rn --arg value "$BASE_REPOSITORY_PATH" '$value|@uri')
BASE_REPOSITORY="$BASE_HOST/$BASE_REPOSITORY_PATH"
BASE_REPOSITORY_SELECTOR=$BASE_REPOSITORY_URL
BASE_PROJECT_ID=$(glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_PATH_ENCODED" | jq -er .id)
MR_LOOKUP=$PR_REFERENCE
case "$PR_REFERENCE" in
  http://*|https://*)
    clean_reference=${PR_REFERENCE%%\?*}
    clean_reference=${clean_reference%/}
    MR_LOOKUP=${clean_reference##*/}
    case "$MR_LOOKUP" in ''|*[!0-9]*) exit 1 ;; esac
    ;;
esac
MR_IID=$(glab -R "$BASE_REPOSITORY_SELECTOR" mr view "$MR_LOOKUP" --output json | jq -er .iid)
MR_JSON=$(glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/merge_requests/$MR_IID")
test "$(echo "$MR_JSON" | jq -er .target_project_id)" = "$BASE_PROJECT_ID"
MR_HEAD_SHA=$(echo "$MR_JSON" | jq -er '.diff_refs.head_sha // .sha')
HEAD_PIPELINE_ID=$(echo "$MR_JSON" | jq -r '.head_pipeline.id // empty')
HEAD_PIPELINE_PROJECT_ID=$(echo "$MR_JSON" | jq -r '.head_pipeline.project_id // empty')
test "$MR_HEAD_SHA" = "$HEAD_SHA"
glab api --hostname "$BASE_HOST" "projects/$BASE_PROJECT_ID" \
  | jq '{only_allow_merge_if_pipeline_succeeds, only_allow_merge_if_all_discussions_are_resolved, merge_method, squash_option}'
if [ -n "$HEAD_PIPELINE_ID" ]; then
  test -n "$HEAD_PIPELINE_PROJECT_ID" # otherwise exact project scope is unprovable: BLOCKED
  PIPELINE_PROJECT_JSON=$(glab api --hostname "$BASE_HOST" \
    "projects/$HEAD_PIPELINE_PROJECT_ID")
  PIPELINE_REPOSITORY_SELECTOR=$(echo "$PIPELINE_PROJECT_JSON" | jq -er .web_url)
  PIPELINE_JSON=$(glab api --hostname "$BASE_HOST" \
    "projects/$HEAD_PIPELINE_PROJECT_ID/pipelines/$HEAD_PIPELINE_ID")
  test "$(echo "$PIPELINE_JSON" | jq -er .sha)" = "$HEAD_SHA"
  glab api --hostname "$BASE_HOST" --paginate \
    "projects/$HEAD_PIPELINE_PROJECT_ID/pipelines/$HEAD_PIPELINE_ID/jobs"
fi
glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/merge_requests/$MR_IID/status_checks"
glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/merge_requests/$MR_IID/approvals"
glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/merge_requests/$MR_IID/approval_state"
glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/protected_branches/$TARGET_BRANCH_ENCODED"
glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/repository/branches/$TARGET_BRANCH_ENCODED"
```

Treat a documented 404 proving that external status checks are unavailable as an empty
set; authorization failures or unsupported enumeration are `BLOCKED`. When
`HEAD_PIPELINE_ID` is absent, combine project pipeline policy and repository CI config to
decide `NONE`, `PENDING`, or draft-suppressed `BLOCKED`; never silently treat absence as a
successful pipeline.

For another provider, resolve equivalent policy and exact-head status operations from the
authenticated capability exposed by the harness. Missing equivalents produce `CI: BLOCKED`.

## Monitoring Workflow

### 1. Initial Status Check

```bash
# Get latest commit
git rev-parse HEAD

# Get commit details
git log -1 --format="%H %s"

# Check push status
git log "$CI_REMOTE/$BRANCH"..HEAD
```

### 2. CI Status Polling

**For GitHub Actions:**
```bash
# List workflow runs for the exact commit; required-check truth still comes from the policy
# and exact-SHA check/status API reads above
gh -R "$BASE_REPOSITORY" run list --commit "$HEAD_SHA"

# Get run details
gh -R "$BASE_REPOSITORY" run view "$RUN_ID"

# Watch run status
gh -R "$BASE_REPOSITORY" run watch "$RUN_ID"
```

**For GitLab CI:**
```bash
# Read only the MR's exact head_pipeline selected above
glab api --hostname "$BASE_HOST" \
  "projects/$HEAD_PIPELINE_PROJECT_ID/pipelines/$HEAD_PIPELINE_ID"

# Get the exact pipeline's jobs
glab api --hostname "$BASE_HOST" --paginate \
  "projects/$HEAD_PIPELINE_PROJECT_ID/pipelines/$HEAD_PIPELINE_ID/jobs"

# Get job logs
glab -R "$PIPELINE_REPOSITORY_SELECTOR" ci trace "$JOB_ID"
```

### 3. Real-time Updates

Display status updates every 5-10 seconds:
```
⏳ CI Status: In Progress
  ✓ Build: Success
  ⏳ Tests: Running... (2m 15s)
  ⏳ Lint: Queued
  - Deploy: Pending
```

## Failure Investigation

When CI fails, delegate investigation to the `debugger` skill:

### Skill Invocation

Use the Skill tool to invoke `debugger` with:
- CI job/pipeline ID
- Failed job names
- Relevant log excerpts
- Commit information

Example prompt:
```
Investigate CI failure for commit [SHA]:
- Failed jobs: [job names]
- CI platform: [GitHub Actions/GitLab CI/etc]
- Job logs available via: [command to fetch logs]

Please gather evidence about:
1. What specifically failed (tests, build, lint, etc.)
2. Exact error messages and stack traces
3. Which files/changes are involved
4. Root cause based on evidence

Provide a complete investigation report.
```

### What the Skill Will Do

The `debugger` skill will:
1. Fetch complete CI logs for failed jobs
2. Identify exact error messages and locations
3. Trace the failure through execution flow
4. Gather evidence about environment and context
5. Present findings without proposing fixes

The debugger saves its captures to the branch's evidence store, per the `evidence` skill,
so `create-pr` can show the failure and its resolution in the Testing Plan.

## Output Format

The default watcher may show the human summaries below, but always finish with the exact
`CI:` status line and complete proof block defined by single-reading mode. Lifecycle
callers parse that final contract, not the emoji summary.

### Success Case

```
✅ CI Status: All checks passed!

📊 Summary:
  ✓ Build: Success (1m 23s)
  ✓ Tests: 156 passed (2m 45s)
  ✓ Lint: No issues (0m 15s)
  ✓ Security: No vulnerabilities (0m 38s)

🎉 CI and code-level mergeability are green; review requirements are reported below.
```

### Failure Case

```
❌ CI Status: Failed

📊 Summary:
  ✓ Build: Success (1m 23s)
  ❌ Tests: 2 failed, 154 passed (2m 45s)
  ⚠️ Lint: 3 warnings (0m 15s)
  ✓ Security: No vulnerabilities (0m 38s)

🔍 Launching `debugger` to investigate...
```

**Then present the skill's complete investigation report, which will include:**
- Problem Investigation Report
- Evidence Gathered (logs, errors, stack traces)
- Root Cause Analysis (based on facts)
- Affected Components
- Recommendations for Resolution

The skill's report provides evidence-based findings without implementing fixes.

## Error Handling

- **No CI Configuration:** Emit `CI: NONE` with the complete proof block
- **Authentication Required:** Emit `CI: BLOCKED` with the failed evidence read
- **API Rate Limits:** In watcher mode, delay and retry; in `--once`, emit `CI: BLOCKED`
- **Network Issues:** In watcher mode, retry with exponential backoff; in `--once`, emit
  `CI: BLOCKED`
- **Long-running CI:** Keep waiting. Extensive CI is a feature, not a fault — see "Patience" below
- **Partial Logs:** Attempt to work with available information

## Patience

A pipeline that has been running for an hour is not a stalled pipeline. On projects where
CI is trusted enough to gate a merge, the suite is extensive on purpose — and when several
branches land at once, shared runners queue, so a job can sit in `Queued` for a long while
before it even starts. Both are normal.

So: never conclude from elapsed time alone that CI is stuck, broken, or worth abandoning.
Do not suggest skipping it, re-running it to "unstick" it, or merging without it. The only
things that end the wait are a terminal result, an explicit `CI_CHECK_TIMEOUT`, or the user
telling you to stop. At an explicit timeout, take one last exact-head reading and return
`CI: PENDING — timeout reached; <n> running, <n> queued, <n> completed` plus the complete
proof block. A timeout does not turn a pending check into failure or success. If no timeout
was supplied and it's taking a while, say what it's still waiting on and keep going.

## Platform-Specific Features

### GitHub Actions

- Support for matrix builds (multiple job variations)
- Artifact download for detailed logs
- Re-run failed jobs command
- Workflow dispatch triggers

### GitLab CI

- Pipeline stage analysis
- Manual job triggers
- Merge request pipeline support
- Child pipeline detection

## Configuration Options

Users can customize behavior via environment variables:

- `CI_CHECK_TIMEOUT`: Positive whole seconds to wait for CI completion (default: unset — wait indefinitely)
- `CI_POLL_INTERVAL`: How often to check status (default: 10s)

## Final Instructions

### Core Workflow
1. Always start by checking the latest commit unless specified otherwise
2. Detect CI platform automatically - don't assume GitHub Actions
3. Monitor CI status continuously without requiring user input
4. When CI completes:
   - **Success** → Present success summary with timing details
   - **Failure** → Launch `debugger` immediately

### Skill Delegation
5. When launching `debugger`:
   - Provide commit SHA and job details
   - Include command to fetch relevant logs
   - Specify which jobs failed
    - Let the skill conduct systematic investigation

### Reporting
6. Present the skill's complete investigation report
7. The skill's report will be evidence-based, not solution-based
8. Never modify code or implement fixes automatically
9. Wait for human decision on next steps after presenting findings

### Error Handling
10. Handle multiple CI platforms if repository uses several
11. If CI is still running, keep waiting and reporting progress — a long pipeline is not a stalled one

## Usage Examples

```bash
# Check CI for latest commit
/check-ci

# Check CI for specific commit
/check-ci abc1234

# Check CI for a branch
/check-ci feature/new-api
```
