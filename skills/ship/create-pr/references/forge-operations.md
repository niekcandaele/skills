# Forge operations

Read this reference whenever `create-pr` must inspect or mutate a pull request or merge
request. Build one **forge binding** for the current repository before performing the
requested operation. The binding is the sole provider-specific layer; callers such as
`player-coach` describe lifecycle intent only through `create-pr` flags.

Body files are the input of record so Markdown stays literal. Where a CLI has
no file flag, read that file exactly once into the command argument. Resolve the current
branch with `git branch --show-current` and the full head SHA with `git rev-parse HEAD`
before mutation.

## Binding contract

A binding supplies these operations:

| Operation | Required behavior |
|---|---|
| `default-target` | Return the repository's default branch. |
| `inspect` | Inspect the explicit PR/MR reference when supplied, otherwise find the open change for the current branch; return URL, number/IID, canonical base/head repository identities, source/target branches, draft state, title/body, full remote head SHA, mergeability, queue state, and merged state. |
| `fetch-head` | Fetch the selected change's exact head object without checking it out, and prove it equals the inspected full SHA. |
| `push` | Push the current branch to a configured remote whose canonical repository identity equals the inspected head repository, and establish its upstream. |
| `create` | Create a normal, reviewable change from the current branch. |
| `draft` | Create a draft, or update the existing change and leave it draft. |
| `update` | Replace the existing change's body and, only when explicitly requested, title; never retarget it or change draft state. |
| `ready` | Mark the existing draft ready without merging it. |
| `reviewer` | Request review from a resolved handle distinct from the authenticated user. |
| `labels` | List and apply only labels that already exist. |
| `merge-policy` | Return provider-allowed merge methods and the repository's required/preferred method. |
| `merge` | Merge the exact ready head with the repository's permitted method and confirm observed merged state; used only by an authorized caller such as `epic-runner`. |

`inspect`, `push`, `draft`, `update`, and `ready` are required by the durable PR lifecycle.
`fetch-head` is conditionally required only when an inspected head is absent from the local
object store and the selected path must render its diff. If the
selected provider cannot perform a requested required operation, fail before mutating
anything else in that invocation. `reviewer` is best-effort: a missing candidate or failed
assignment is reported but never reverses a successful ready transition.

Resolve repository identity before any mutation. The selected change's base and head
repositories are independent. Enumerate configured remotes and canonicalize each URL,
including the provider hostname. Choose exactly one `BASE_REMOTE` equal to the base and one
`PUSH_REMOTE` equal to the head; either may be `origin`, but never assign a role from its
name. Missing or ambiguous matches fail preflight. Every number/IID-based provider command
is explicitly scoped to the canonical base repository.

For an existing change, its provider record is authoritative for both identities. For a new
change, resolve the base from explicit authenticated repository context, a configured
upstream/parent relationship, or the sole provider repository that owns the requested target
branch, in that order; fail rather than guess among candidates. Resolve and fetch the target
through `BASE_REMOTE` before branch creation. A fork's `origin` commonly becomes
`PUSH_REMOTE` while `upstream` becomes `BASE_REMOTE`.

For a new change with nothing to inspect, resolve the source branch's configured push remote
first. If none exists, use the sole authenticated writable remote; more than one candidate
is ambiguous and fails preflight. Canonicalize that remote's repository identity as
`HEAD_REPOSITORY` (and its owner/namespace where the provider needs one), and pass it
explicitly to change creation. Do not infer the head repository from the base repository.

Provider capability is not preference. For `merge-policy`, combine provider-allowed
methods with an explicit repository rule from its engineer skill, CONTRIBUTING guidance,
or caller context. If several methods remain and none is declared preferred, fail the
operation; never silently choose squash.

This binding has no comment operation. `create-pr` writes the description and nothing else:
it never creates a top-level comment, note, or inline review on a change.

## GitHub binding

Use `gh` for repositories whose authenticated provider is GitHub.

```bash
# inspect; PR_SELECTOR is the explicit --pr value or current branch. BASE_REPOSITORY is
# canonical HOST/OWNER/REPO; BASE_REPOSITORY_PATH is OWNER/REPO for REST endpoints.
PR_JSON=$(gh -R "$BASE_REPOSITORY" pr view "$PR_SELECTOR" \
  --json url,number,headRepository,headRepositoryOwner,headRefName,baseRefName,isDraft,title,body,headRefOid,mergeable,state,autoMergeRequest)
PR_NUMBER=$(echo "$PR_JSON" | jq -er .number)
HEAD_REPOSITORY_PATH=$(echo "$PR_JSON" \
  | jq -er '.headRepository.nameWithOwner // ((.headRepositoryOwner.login // .headRepositoryOwner.name) + "/" + .headRepository.name)')
HEAD_REPOSITORY="$BASE_HOST/$HEAD_REPOSITORY_PATH"
HEAD_OWNER=${HEAD_REPOSITORY_PATH%%/*}

# before create, when no PR exists: the binding canonicalized PUSH_REMOTE to the
# provider's [HOST/]OWNER/REPO form as CANONICAL_PUSH_REPOSITORY
HEAD_REPOSITORY_PATH=$(gh repo view "$CANONICAL_PUSH_REPOSITORY" \
  --json nameWithOwner --jq .nameWithOwner)
HEAD_REPOSITORY="$BASE_HOST/$HEAD_REPOSITORY_PATH"
HEAD_OWNER=${HEAD_REPOSITORY_PATH%%/*}

# default target
gh -R "$BASE_REPOSITORY" repo view --json defaultBranchRef --jq .defaultBranchRef.name

# fetch exact selected head without checkout
git fetch "$BASE_REMOTE" "pull/$PR_NUMBER/head:refs/remotes/$BASE_REMOTE/pr/$PR_NUMBER"
test "$(git rev-parse "refs/remotes/$BASE_REMOTE/pr/$PR_NUMBER")" = "$HEAD_SHA"

# push; PUSH_REMOTE was matched to the inspected head repository
git push -u "$PUSH_REMOTE" "$BRANCH"

# create draft
gh -R "$BASE_REPOSITORY" pr create --draft --title "$TITLE" --body-file "$BODY_FILE" \
  --base "$TARGET_BRANCH" --head "$HEAD_OWNER:$BRANCH"

# create normal reviewable change
gh -R "$BASE_REPOSITORY" pr create --title "$TITLE" --body-file "$BODY_FILE" \
  --base "$TARGET_BRANCH" --head "$HEAD_OWNER:$BRANCH"

# draft: update an existing change and ensure it is draft; add --title only for an explicit title
gh -R "$BASE_REPOSITORY" pr edit "$PR_NUMBER" --body-file "$BODY_FILE"
gh -R "$BASE_REPOSITORY" pr ready "$PR_NUMBER" --undo  # only for --draft when inspect says it is ready

# update without changing state/target; add --title only for an explicit title
gh -R "$BASE_REPOSITORY" pr edit "$PR_NUMBER" --body-file "$BODY_FILE"

# mark ready
gh -R "$BASE_REPOSITORY" pr ready "$PR_NUMBER"

# resolve identity and request a distinct reviewer
gh api user --jq .login
gh -R "$BASE_REPOSITORY" pr edit "$PR_NUMBER" --add-reviewer "$REVIEWER"

# resolve allowed methods, then use the repository-required/preferred one
gh -R "$BASE_REPOSITORY" repo view \
  --json mergeCommitAllowed,rebaseMergeAllowed,squashMergeAllowed
case "$MERGE_METHOD" in
  squash) gh -R "$BASE_REPOSITORY" pr merge "$PR_NUMBER" --squash --match-head-commit "$HEAD_SHA" ;;
  merge) gh -R "$BASE_REPOSITORY" pr merge "$PR_NUMBER" --merge --match-head-commit "$HEAD_SHA" ;;
  rebase) gh -R "$BASE_REPOSITORY" pr merge "$PR_NUMBER" --rebase --match-head-commit "$HEAD_SHA" ;;
  *) exit 1 ;;
esac
gh -R "$BASE_REPOSITORY" pr view "$PR_NUMBER" \
  --json state,autoMergeRequest,mergeStateStatus

# existing labels
gh -R "$BASE_REPOSITORY" label list --json name --jq '.[].name'
gh -R "$BASE_REPOSITORY" pr edit "$PR_NUMBER" --add-label "$LABEL"
```

Use `gh pr view` again after `draft` or `ready` and confirm the expected `isDraft` value.
A successful command with the wrong observed state is a failed operation.

## GitLab binding

Use `glab` for GitLab.com and self-managed GitLab repositories. `glab mr view --output
json` supplies the project ID and MR IID needed by API operations.

```bash
# base initialization for inspect or create. BASE_SELECTOR is the project URL parsed from
# an explicit MR URL, otherwise the configured BASE_REMOTE URL/provider context.
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
# For an explicit URL, parse BASE_SELECTOR from everything before /-/merge_requests/<IID>
# and reject any host/path that disagrees with the canonical values above.
MR_LOOKUP=$PR_SELECTOR
case "$PR_SELECTOR" in
  http://*|https://*)
    clean_selector=${PR_SELECTOR%%\?*}
    clean_selector=${clean_selector%/}
    MR_LOOKUP=${clean_selector##*/}
    case "$MR_LOOKUP" in ''|*[!0-9]*) exit 1 ;; esac
    ;;
esac
MR_IID=$(glab -R "$BASE_REPOSITORY_SELECTOR" mr view "$MR_LOOKUP" --output json | jq -er .iid)
MR_JSON=$(glab api --hostname "$BASE_HOST" \
  "projects/$BASE_PROJECT_ID/merge_requests/$MR_IID")
test "$(echo "$MR_JSON" | jq -er .target_project_id)" = "$BASE_PROJECT_ID"
HEAD_PROJECT_ID=$(echo "$MR_JSON" | jq -er .source_project_id)
HEAD_PROJECT_JSON=$(glab api --hostname "$BASE_HOST" "projects/$HEAD_PROJECT_ID")
HEAD_REPOSITORY_PATH=$(echo "$HEAD_PROJECT_JSON" | jq -er .path_with_namespace)
HEAD_REPOSITORY_URL=$(echo "$HEAD_PROJECT_JSON" | jq -er .web_url)
HEAD_REPOSITORY="$BASE_HOST/$HEAD_REPOSITORY_PATH"
HEAD_REPOSITORY_SELECTOR=$HEAD_REPOSITORY_URL

# before create, when no MR exists: derive HEAD_REPOSITORY from the selected PUSH_REMOTE's
# canonical host/project path and retain a CLI selector for the source project
HEAD_PROJECT_JSON=$(glab -R "$(git remote get-url "$PUSH_REMOTE")" repo view --output json)
HEAD_REPOSITORY_PATH=$(echo "$HEAD_PROJECT_JSON" \
  | jq -er '.path_with_namespace // .full_path')
HEAD_REPOSITORY_URL=$(echo "$HEAD_PROJECT_JSON" | jq -er .web_url)
HEAD_REPOSITORY="$BASE_HOST/$HEAD_REPOSITORY_PATH"
HEAD_REPOSITORY_SELECTOR=$HEAD_REPOSITORY_URL

# default target
glab -R "$BASE_REPOSITORY_SELECTOR" repo view --output json \
  | jq -er '.default_branch // .defaultBranch'

# fetch exact selected head without checkout
git fetch "$BASE_REMOTE" "merge-requests/$MR_IID/head:refs/remotes/$BASE_REMOTE/mr/$MR_IID"
test "$(git rev-parse "refs/remotes/$BASE_REMOTE/mr/$MR_IID")" = "$HEAD_SHA"

# push
git push -u "$PUSH_REMOTE" "$BRANCH"

# create draft
glab -R "$BASE_REPOSITORY_SELECTOR" mr create --draft --yes --title "$TITLE" \
  --description "$(<"$BODY_FILE")" --target-branch "$TARGET_BRANCH" \
  --source-branch "$BRANCH" --head "$HEAD_REPOSITORY_SELECTOR"

# create normal reviewable change
glab -R "$BASE_REPOSITORY_SELECTOR" mr create --yes --title "$TITLE" \
  --description "$(<"$BODY_FILE")" --target-branch "$TARGET_BRANCH" \
  --source-branch "$BRANCH" --head "$HEAD_REPOSITORY_SELECTOR"

# update existing change and keep it draft; add --title only for an explicit title
glab -R "$BASE_REPOSITORY_SELECTOR" mr update "$MR_IID" --draft --yes \
  --description "$(<"$BODY_FILE")"

# update without changing draft state/target; add --title only for an explicit title
glab -R "$BASE_REPOSITORY_SELECTOR" mr update "$MR_IID" --yes \
  --description "$(<"$BODY_FILE")"

# mark ready
glab -R "$BASE_REPOSITORY_SELECTOR" mr update "$MR_IID" --ready --yes

# resolve identity/candidate and request review
glab api --hostname "$BASE_HOST" user | jq -er .username
glab api --hostname "$BASE_HOST" "users?username=$REVIEWER" | jq -er '.[0].id'
glab -R "$BASE_REPOSITORY_SELECTOR" mr update "$MR_IID" --reviewer "+$REVIEWER" --yes

# resolve project merge/squash policy; GitLab applies merge_method server-side
PROJECT_POLICY=$(glab api --hostname "$BASE_HOST" "projects/$BASE_PROJECT_ID")
MERGE_METHOD=$(echo "$PROJECT_POLICY" | jq -er .merge_method)
SQUASH_OPTION=$(echo "$PROJECT_POLICY" | jq -er .squash_option)
case "$MERGE_METHOD" in merge|rebase_merge|ff) ;; *) exit 1 ;; esac
case "$SQUASH_OPTION" in
  always|default_on)
    glab -R "$BASE_REPOSITORY_SELECTOR" mr merge "$MR_IID" --sha "$HEAD_SHA" --yes --squash
    ;;
  never|default_off)
    glab -R "$BASE_REPOSITORY_SELECTOR" mr merge "$MR_IID" --sha "$HEAD_SHA" --yes
    ;;
  *) exit 1 ;;
esac
glab -R "$BASE_REPOSITORY_SELECTOR" mr view "$MR_IID" --output json \
  | jq '{state: .state, queued: (.merge_when_pipeline_succeeds // false), mergeStatus: (.detailed_merge_status // .merge_status)}'

# existing labels
glab -R "$BASE_REPOSITORY_SELECTOR" label list --output json
glab -R "$BASE_REPOSITORY_SELECTOR" mr update "$MR_IID" --label "$LABEL" --yes
```

Inspect again after `draft` or `ready`; confirm the returned draft/work-in-progress state.
For an explicit URL, require the inspected canonical URL to identify the selected base
repository and normalized IID; reject a mismatched selector, but permit a checkout whose
`origin` is the MR's inspected head fork.
## Other authenticated providers

Remote-host string matching is only a hint. If the repository is neither GitHub nor
GitLab, inspect the authenticated provider capabilities exposed by the harness and resolve
an equivalent binding with all requested required operations. Write down the concrete
operation names or commands before the first mutation, including how draft state is
verified.

If no authenticated capability supplies an exact equivalent, stop with the missing
operation named.
