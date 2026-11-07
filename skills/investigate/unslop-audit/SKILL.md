---
name: unslop-audit
description: >-
  Periodic whole-repo health audit for an agent-run codebase: scouts mine session history, the
  tracker, CI, production telemetry and the code; deep-dives verify and design fixes with
  diagrams; skeptics attack each proposal; a critic hunts gaps. Ends in a picture-first report
  page of ranked, sequenced proposals. Expensive (about 60-70 subagents).
argument-hint: "[--repo=<path>] [--skip=<lane,...>] [--candidates=18-24]"
disable-model-invocation: true
allowed-tools:
  - Read
  - Write
  - Bash
  - Grep
  - Glob
  - Agent
  - Skill
  - Workflow
  - Artifact
metadata:
  group: investigate
  requires: [thermo-nuclear-code-quality-review, improve-codebase-architecture, codebase-design, ponytail, ponytail-review]
  optional: [visual-verify, to-tickets]
---

An agent-run repo — a **software factory** — accrues slop faster than any single change shows it: debt filed as follow-up tickets, workarounds written into gotcha docs, gates that exist only as prose, signals that are always red. This audit is the periodic **garbage collection**: it gathers evidence from every place the factory leaves traces, turns it into a small set of verified, sequenced proposals, and draws them.

You are the **orchestrator**. Subagents do the reading; you hold the judgement: the brief, the order of work, and the page. The whole run is **read-only**: no repo edits, commits, tracker writes, environment changes, or mutating MCP calls. You file tickets and PRs afterwards only when the human asks.

## 1. Brief

Bind the run to this repo. If it has an engineer skill, invoke it first, and pass its name so every subagent does too. Then fill the brief, the `args` documented at the top of [`scripts/audit.workflow.js`](scripts/audit.workflow.js):

- `repo`, `scratchpad`, `today`, `project` (one line: stack and shape), `tracker` (how to query it), `rules` (the repo's own hard don'ts, e.g. "never start a dev environment").
- `history`: every agent transcript store on this machine. Look across all harness accounts, not just the current one: resolve symlinks and dedupe. For example, Claude Code keeps `~/.claude/projects` plus one per extra config dir, and Codex keeps `~/.codex`. `match` holds the substrings that pick this repo's project dirs.
- `prod`: a read-only observability MCP (logs, metrics, traces, database) if one is connected. Note which of its tools mutate; the scouts must not call them.
- `areas`: backend, frontend and tooling paths for the code-review lanes.
- `windows`: transcript date ranges counted back from `today`.
- `models` by cost tier. `scout` and `skeptic` are mid tier. `reviewer`, `dive` and `lead` are the strongest tier below yours.
- `previous`: if `~/.local/share/unslop-audit/<repo>/` holds an earlier run, pass its proposals' `{id, title, score}` so recurring problems keep their ids and show their trend.
- `skip`: lanes whose source this repo lacks. A lane with a missing source (no transcripts, no prod) drops out by itself.

Done when every arg is filled, or deliberately left empty with its lane skipped. Save the brief as `brief.json` in the scratchpad.

## 2. Fan out

Run the script with the brief as its input. With Claude Code's workflow runner that is `Workflow({ scriptPath: "<this skill>/scripts/audit.workflow.js", args: <brief> })`; it runs in the background and notifies you when it finishes. On a harness without a workflow runner, dispatch the same prompts as subagents: the lanes in parallel, then synthesis, then a dive→skeptic pair per candidate, then the critic. Tell the human the expected cost first, in one line. The first run took 66 agents, about 6M tokens and 2.5 hours.

The **lanes** (scouts) are defined once, in `LANES` in the script: three transcript windows, Codex history, flaky CI, follow-up tickets, encoded debt, prod ops, prod data, backend architecture, frontend and tooling thermo-nuclear reviews, deletion, churn hot spots, test health, security and dependencies, and the software factory itself. Add a repo-specific lane through `extraLanes` rather than by editing the script.

Wait for the completion notice.

## 3. Read

Condense the output with `jq` (`.result.results[] | {proposal, challenge}`, `.result.critic`) and read every proposal together with its challenge. The skeptic's `priority_score` is the score. Its `claims_checked` and `effort_risk_correction` override the deep-dive wherever they disagree.

Done when you can state, for every proposal, its score, its biggest objection, and where the critic sequenced it.

## 4. Overview

Write `overview.json`, the judgement half of the page: themes, stat tiles, evidence charts, waves, the dependency graph, and the factory rules. The contract is in [`references/overview.md`](references/overview.md). Every number on the page traces back to a proposal or a scout note (`scout-*.md` in the scratchpad).

## 5. Build

```bash
node <this skill>/scripts/build-page.mjs --output <workflow output json> --overview overview.json --out <name>-unslop-audit.html
```

The build refuses themes missing from the overview and inline script that fails to parse. It lists proposals that lack before/after diagrams. For each one listed, dispatch a cheap-tier illustrator subagent with the proposal and the `MERMAID_RULES` from the script, write its `visual` into a copy of the output, and rebuild.

Done when the list is empty. Every card then opens on pictures: a priority, effort, risk, footprint and breaking-change strip; today vs after-the-fix diagrams; now vs target bars; and the skeptic's claim ledger. The prose comes after the pictures.

## 6. Look

Render the page headless, for example with Playwright. Check light and dark at 1280px and a 390px phone. Open two cards and look at the screenshots: no console errors, diagrams legible, no horizontal scroll. If `visual-verify` is installed, it does this pass.

## 7. Hand over

- Archive `brief.json`, the output, `overview.json`, the page and the scout notes to `~/.local/share/unslop-audit/<repo>/<today>/`. The next run's `previous` comes from there.
- Copy the page somewhere durable for the human, and publish it as a private shared page when the harness can.
- Report: the link and the path, Wave 0, the claims the skeptics refuted, and any assumption a proposal rests on that nobody tested. Offer `to-tickets` for the waves the human picks.
