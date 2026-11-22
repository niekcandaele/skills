# Backend: antigravity

The Antigravity CLI (`agy`), running a Gemini model. Read this from step 0 of `SKILL.md`; every
rule there still applies.

| | |
|---|---|
| Prerequisites | `which agy` |
| Login check (used by `second-model`) | `agy models` exits 0 |
| Model | `gemini-4-carbon-medium` by default — High measured up to 35 min on large PRs; `gemini-4-carbon-{low,medium,high}` need Google AI Ultra |
| Structured verdict | `.structured_output.findings` in `$TMP_REVIEW_DIR/agy.json` |
| Fallback source | `.response` in `$TMP_REVIEW_DIR/agy.json` — a JSON string to parse, or prose |
| Log to quote | `.error` and `.status` in `agy.json`, then the tail of `$TMP_REVIEW_DIR/agy.stderr` |
| Run time | see the table below |

Install is `curl -fsSL https://antigravity.google/cli/install.sh | bash`, into `~/.local/bin/agy`;
it self-updates. Login is interactive (`agy`, then sign in; over SSH it is a paste-code flow) and
the token lives in the OS keyring.

## Model guard

**Only `gemini-*` models.** Antigravity also serves non-Gemini models, including Claude. One of
those would review with the orchestrator's own model family, and a second review with no
diversity in it is what this skill exists to prevent. `second-model` refuses to store such a
model; if one reaches you anyway, report `BACKEND_REVIEW_FAILED` naming it rather than running.

## The run command

**Hand agy the diff as a file, never in argv.** agy cannot be trusted to fetch it: in headless
mode a shell command needs a permission nobody can grant, so a prompt that says "review
`git diff`" gets its `git` call soft-denied and the run ends `SUCCESS` with
`structured_output: null` and nothing reviewed (observed 2026-11-22). Nor can the diff ride in
the prompt: Linux caps one argv string at 128 KiB, and a 203 KB diff failed instantly with
`argument list too long: agy`, exit 127. So the script writes the diff to
`$TMP_REVIEW_DIR/review.diff` — outside `repo/`, so the tamper check and the review scope are
untouched — and the prompt tells agy to read that absolute path. `--add-dir` grants the access.

`run.sh`, with `T` the literal temp path:

```bash
date +%s > T/start.ts
git -C T/repo diff > T/review.diff
cd T/repo && agy -p "You are reviewing a code change to this workspace. The complete diff is in T/review.diff ($(wc -c < T/review.diff) bytes). Read all of it first, in chunks if it is large. You may read files in this workspace for context, but do not run commands.

$(cat T/review-prompt.txt)" \
  --add-dir T \
  --model "<model>" \
  --mode plan \
  --output-format json \
  --json-schema T/findings.schema.json \
  --print-timeout 60m \
  < /dev/null \
  > T/agy.json 2> T/agy.stderr
echo "$?" > T/backend.exit
```

**Never add `--disable-slash-commands`.** `--mode plan` works by prefixing `/plan`, and with
slash expansion disabled agy warns `--mode plan has no effect` and runs unrestricted.

`--print-timeout 60m` sits inside the 65-minute `SECOND_MODEL_REVIEW_TIMEOUT`, so agy gives up and
writes its envelope before the wait budget runs out.

**`--mode plan` is a prompt prefix, not enforcement.** On a personal account with a working
sandbox, `agy -p` may run in auto mode and edit files. The tamper check in step 4 of `SKILL.md`
is what catches a review that edited the workspace — never skip it for this backend.

`stdout` is one JSON envelope: `{status, response, structured_output, error, num_turns, usage, …}`.
Report `usage` token counts in the Notes when present.

## Signals

- exit 126/127 or `argument list too long` with an empty `agy.json` -> a launch failure: see
  `SKILL.md`'s Failure Handling; the shell's message is in `agy.stderr` or `launch.stderr`.
- `authentication required` -> `BACKEND_AUTH_MISSING`
- `secret keyring is locked` -> `BACKEND_AUTH_MISSING`. The login exists but the OS keyring
  holding it is locked or unreachable — on a headless session, usually no D-Bus session, or a keyring daemon
  that was never unlocked. Say so in the Notes; logging in again does not fix it.
- unknown or unavailable model -> `BACKEND_REVIEW_FAILED`, naming the model. The Carbon models
  need an Ultra subscription on the signed-in account.
- envelope `status` is an error mentioning quota or a limit -> `BACKEND_USAGE_LIMIT`. The exact
  text is undocumented: on the first real occurrence, record the verbatim text here.
- tool soft-denial notices on stderr -> NOT failures. agy denies a tool, carries on, and still
  exits 0.
- `structured_output: null` with an empty `response`, or one that holds no review ->
  `BACKEND_REVIEW_FAILED`, whatever the exit code and envelope `status`, quoting any stderr
  notice (typically a tool that "was auto-denied"). A clean review from agy always fills
  `structured_output`, even if only with `{"findings": []}`, so this is never a "no issues"
  result.
- otherwise, exit 0 with parseable findings is a completed review, whatever stderr contains.

## Run time

Measured 2026-11-22, Carbon High (the default is now Medium for speed). Wall clock does not track diff size closely. Large PRs spend 737k-1.06M tokens.

| Diff | Wall clock |
|---|---|
| 2 lines | 1 min 45 s (~20k tokens) |
| 415 lines | ~14 min |
| 64 KB, 23 files | ~21 min |
| 79 KB, 46 files | ~21 min |
| 115 KB, 65 files | ~18 min |
| 138 KB, 36 files | ~22 min |
| 203 KB, 44 files | ~17 min |
| 40 files, +884/-522 | ~35 min |

Record new sizes here, especially anything near the `--print-timeout`.
