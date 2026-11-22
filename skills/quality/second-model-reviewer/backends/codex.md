# Backend: codex

The Codex CLI (`codex`). Read this from step 0 of `SKILL.md`; every rule there still applies.

| | |
|---|---|
| Prerequisites | `which codex`, `codex exec --help` |
| Login check (used by `second-model`) | `codex login status` |
| Model | Codex's own default; `second-model use codex --model <m>` adds `--model <m>` |
| Structured verdict | `$TMP_REVIEW_DIR/codex-verdict.json` |
| Fallback source | the last `agent_message` / `item.completed` events in `$TMP_REVIEW_DIR/codex-events.jsonl` |
| Log to quote | `$TMP_REVIEW_DIR/codex-events.jsonl` |
| Run time | **~5.5 min median, ~17 min p90** |

## Run Codex via `codex exec` (NOT `codex review`)

**Use `codex exec`, not `codex review`.** `codex review` rejects `--json` and
`--output-last-message` (verified — `error: unexpected argument`), so it has no machine-readable
output; its verdict is a trailing human-rendered markdown block on stdout that is **duplicated**
and **interleaved with `ERROR codex_core::session` log lines**.

`codex exec` runs the **same model** and we already materialise the scoped diff in the temp
workspace, so this is not "reinventing review" — it reuses our diff plus a review prompt and
adds deterministic, file-based capture (`--output-last-message`, `--json`, `--output-schema`).

> **Scope note:** `exec`-over-`review` and the structured-output flags are **parsing-fidelity**
> improvements, not reliability fixes. Measured across ~500 historical invocations they show no
> completion-rate benefit (58% vs 69% June; 40% vs 50% July). What actually determines whether a
> run succeeds is the completion contract in step 3b. Do not over-trust these flags.

**The run command** — `run.sh`, with `T` the literal temp path (add `--model "<model>"` after
`--json` only when `resolve` printed one):
```bash
date +%s > T/start.ts
cd T/repo && codex exec --json \
  --output-last-message T/codex-verdict.json \
  --output-schema       T/findings.schema.json \
  --sandbox read-only \
  "Review ONLY the uncommitted changes shown by \`git diff\` in this workspace; files marked intent-to-add are part of the change.

$(cat T/review-prompt.txt)" \
  < /dev/null \
  > T/codex-events.jsonl 2>&1
echo "$?" > T/backend.exit
```

**Use `cd`, not a flag, to set the working directory.** `codex exec` has **no `--cwd` option**
(verified: `error: unexpected argument '--cwd' found`). Inventing one exits 2 immediately and
wastes a launch. Codex reviews the diff in whatever directory it is started from.

**`< /dev/null` is mandatory.** `codex exec` blocks indefinitely on
`Reading additional input from stdin...` if stdin is left open — a silent hang that looks like a
timeout. Cause: codex appends piped stdin to the prompt, so it reads until an EOF that a
never-closed pipe never delivers. A terminal (TTY) is skipped, which is why manual runs always
work and harness runs hang. Reproduced: without it, 39 bytes of output and no verdict file,
forever; with it, exit 0 and a valid verdict. Always close stdin.

`codex-verdict.json` (the `--output-last-message` file) is always written on clean exit. No
interleaved `ERROR` lines reach it, so it needs no stripping.

## Signals

- exit 126/127 with an empty events log -> a launch failure: see `SKILL.md`'s Failure Handling; the shell's message is in `codex-events.jsonl` or `launch.stderr`.
- login/authentication error -> `BACKEND_AUTH_MISSING`
- a `turn.failed` event whose message contains "You've hit your usage limit" -> `BACKEND_USAGE_LIMIT`.
  This is a **quota** condition, not auth, not network, and not a review failure. Report it as
  itself and say when the limit resets if Codex states it. Measured: all 10 quota failures in the
  historical corpus were mislabelled — 4 as auth missing, 3 as review failed, 2 as network
  blocked — which made one recurring condition look like three unrelated bugs.
- websocket/DNS/permission denied network errors -> `BACKEND_NETWORK_BLOCKED`
- `backend.exit` exists and is non-zero, with no parseable findings -> `BACKEND_REVIEW_FAILED`, quoting the tail of `codex-events.jsonl`.
- `Reading additional input from stdin...` in the log with no further progress -> NOT a real hang: stdin was left open. Re-run with `< /dev/null`. Do not report this as `BACKEND_REVIEW_FAILED`.
- Transient `rmcp::transport` / HTTP 5xx lines in the events log -> NOT fatal. These hit Codex's MCP sidecar, not the review thread, and it recovers. Only a `turn.failed` event or a non-zero `backend.exit` is terminal.
- ~1000 lines of `codex_core::session: failed to load skill …` at startup -> **normal noise**, unrelated to the review. Never treat it as failure.
