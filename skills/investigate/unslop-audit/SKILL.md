---
name: unslop-audit
description: >-
  Periodic whole-repo health audit: scouts gather evidence from whatever the repo has (agent
  history, tracker, CI, telemetry, code); deep-dives verify and design fixes with before/after
  diagrams; skeptics attack each proposal; a critic hunts gaps. Every open ticket is read and
  accounted for. Ends in a picture-first report page of ranked, sequenced proposals. Expensive
  (dozens of subagents).
argument-hint: "[--repo=<path>] [--candidates=12-20]"
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
  optional: [thermo-nuclear-code-quality-review, improve-codebase-architecture, codebase-design, ponytail-review, rich-page, visual-verify, to-tickets]
---

A repo accrues slop faster than any single change shows it, and an agent-run repo accrues it fastest. The signs: debt filed as follow-up tickets, workarounds written into gotcha docs, gates that exist only as prose, signals that are always red. This audit is the periodic **garbage collection**. It gathers evidence from every place the work leaves traces, turns that evidence into a small set of verified, sequenced proposals, and draws them.

You are the **orchestrator**. Subagents do the reading; you hold the judgement: which lanes to run, the order of work, and the page. The whole run is **read-only**: no repo edits, commits, tracker writes, environment changes, or mutating MCP calls. You file tickets and PRs afterwards only when the human asks.

Read-only is enforced only by the prompt, and the scouts read untrusted text (issue bodies, transcripts, logs) while holding a shell. Back the rule with enforcement where the harness allows:
- connect observability MCPs with read-only credentials
- run in a permission mode that denies writes or asks before them (subagents inherit it)
- pass a read-only subagent type as `agentType` when one exists

## 1. Brief

Bind the run to this repo. If it has an engineer skill, invoke it first and pass its name, so every subagent does too.

Then survey which evidence sources this repo really has: transcript stores (across all harness accounts on the machine), the tracker, CI history, observability MCPs, docs and ADRs, and the code areas. From that, write 8-16 **lanes**, using [`references/lanes.md`](references/lanes.md) as a menu and adding lanes this product needs. Every lane prompt names its concrete source: paths, commands, MCP name, date range.

**Ticket census.** A tracker lane that samples misses the long tail, so the census gives every open ticket to exactly one lane:
- Count the open tickets by kind, by author or agent role, and by product area.
- Split any bucket above about 60 tickets until one scout can read every ticket in it.
- Give each bucket a lane whose prompt carries the exact query that selects it and its count.
- Tickets that already group others (root-cause, cluster or epic tickets) form their own "prepared clusters" lanes.

Save it in the brief as `census: { total, buckets: [{ label, count, lane }] }`. Ticket lanes come on top of the 8-16.

Fill the rest of the `args` documented at the top of [`scripts/audit.workflow.js`](scripts/audit.workflow.js):
- `project`: one line on stack and shape.
- `rules`: the repo's own hard don'ts.
- `models` by cost tier. `scout` and `skeptic` are mid tier. `reviewer`, `dive` and `lead` are the strongest tier below yours.
- `previous`: if `~/.local/share/unslop-audit/<repo>/` holds an earlier run, the `{id, title, score}` of its proposals. Recurring problems then keep their ids and show their trend.

Done when every lane names a source that exists and the census bucket counts add up to the open-ticket total. Save the brief as `brief.json` in the scratchpad.

## 2. Fan out

Run the script with the brief as input. With Claude Code's workflow runner, that is `Workflow({ scriptPath: "<this skill>/scripts/audit.workflow.js", args: <brief> })`. On a harness without one, dispatch the same prompts as subagents: the lanes in parallel, then synthesis, then a dive→skeptic pair per candidate beside one checker per bundle and per 80 close-list entries, then the critic.

Before starting, tell the human the cost in one line: about lanes + 2 × candidates + bundles + 3 agents. One run with 16 lanes and 24 candidates took about 6M tokens and 2.5 hours; ticket lanes and bundle checks run on the mid tier and add roughly a quarter on a tracker of a thousand tickets. Then wait for the completion notice.

## 3. Read

Condense the output with `jq` (`.result.results[] | {proposal, challenge}`, `.result.critic`). Read every proposal together with its challenge. The score is the skeptic's `priority_score`. Where the skeptic and the deep-dive disagree, the skeptic's `claims_checked` and `effort_risk_correction` win.

Then read the ticket side (`.result.bundles`, `.result.close_list`, `.result.coverage`):
- A **bundle** is a set of small fixes in one area that ships as one PR. It had a light check, not a deep dive.
- The **close list** is tickets the scouts judge not worth doing, each with a reason. Entries a checker removed are already gone.
- **Coverage** counts each open ticket once: closed by a proposal, closed by a bundle, on the close list, standalone, or unexamined. `unplaced` lists tickets a scout grouped that no surviving proposal or bundle claims, usually because a deep dive narrowed its `closes`; `removed_by_check` lists what a checker took out. Both are real open work: show them as standalone.

Done when you can state, for every proposal, its score, its biggest objection, and where the critic sequenced it, and can explain every unexamined and unplaced ticket in the coverage.

## 4. Report

Design one page for this audit's findings. Don't use a template: let the evidence decide the charts, and let the repo decide the sections. Build it with `rich-page` if installed, otherwise with the harness's page tool. The page must have:

- **Pictures before prose in every proposal**: its before/after diagrams, its numbers as now vs target, and its effort, risk and breaking change at a glance. Prose comes after the pictures. Where a dive's diagrams are missing or weak, dispatch a cheap-tier illustrator subagent for that proposal.
- **The headline numbers** as stat tiles and comparison charts (useful vs waste, cause shares, trends).
- **The ranking**, with what the skeptics changed: score shifts and the claims they refuted.
- **Waves**: the order of work, built from the critic's sequencing and then score per effort. Wave 0 is small, safe, and stops active damage. Critic gaps go into a wave too.
- **Ticket coverage** as one picture: of the open tickets, how many a proposal closes, a bundle closes, the close list holds, stand alone, and went unexamined. Each proposal and bundle shows the tickets it closes.
- **The close list**, grouped by reason, so the human can approve it as a batch.
- **Cross-cutting rules**: patterns that several proposals share, each phrased as a mechanism (a check, a budget, a WIP limit).

Every number on the page traces back to a proposal or a scout note (`scout-*.md` in the scratchpad).

## 5. Look

Render the page headless and screenshot it in light and dark at desktop width, and at a 390px phone width. Open two proposals. Done when there are no console errors, the diagrams are legible, and nothing scrolls horizontally. If `visual-verify` is installed, it does this pass.

## 6. Hand over

- Archive `brief.json`, the workflow output, the page and the scout notes to `~/.local/share/unslop-audit/<repo>/<today>/`. The next run's `previous` comes from there.
- Copy the page somewhere durable for the human, and publish it as a private shared page when the harness can.
- Report:
  - the link and the path
  - Wave 0
  - the claims the skeptics refuted
  - any assumption a proposal rests on that nobody tested

  Offer two things, each only on the human's word:
  - `to-tickets` for the waves and bundles the human picks. Each ticket carries its `closes` list, so the fix PR closes the tickets it resolves.
  - applying the close list through the tracker's own closing rules, with each entry's reason as the closing comment.
