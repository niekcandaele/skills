export const meta = {
  name: 'unslop-audit',
  description: 'Codebase health audit: scouts mine history, tickets, CI, prod and code; deep-dives design fixes with diagrams; skeptics challenge each; a critic hunts gaps',
  phases: [
    { title: 'Gather', detail: 'one scout per evidence lane' },
    { title: 'Synthesize', detail: 'cluster findings into candidate problems' },
    { title: 'Deep-dive', detail: 'verify, measure, design the fix, draw it' },
    { title: 'Challenge', detail: 'adversarial skeptic per proposal' },
    { title: 'Critic', detail: 'completeness and sequencing' },
  ],
}

// args (all set by the orchestrator; see SKILL.md "Run brief"):
//   repo, scratchpad, today, project, engineerSkill, rules, tracker,
//   history: { claude: [dirs], match: [substrings], codex: dir|null },
//   prod: { mcp: name|null, hint }, areas: { backend, frontend, tooling },
//   windows: { recent, mid, old }, skip: [lane labels], extraLanes: [{label, tier, prompt}],
//   models: { scout, reviewer, lead, dive, skeptic }, candidates: '18-24',
//   previous: [{ id, title, score }] from the last archived audit, or omitted
const A = args
const SP = A.scratchpad
const M = A.models || {}
const H = A.history || {}

const COMMON = `
You are a scout in a codebase-health ("unslop") audit of ${A.project} at ${A.repo}.
${A.engineerSkill ? `First invoke the \`${A.engineerSkill}\` skill to learn the repo. Then do your assignment.` : 'First read the repo README / AGENTS.md / CLAUDE.md to learn the repo.'}
HARD RULES: strictly READ-ONLY. Edit no repo files; commit, push, comment on, label or create nothing in the tracker; mutate no cluster or environment; call only read/list/query tools on any MCP (never create/update/delete/silence). ${A.rules || ''} Scratch files go under ${SP}.
Goal: find REAL, evidence-backed problems that cost time, money, reliability or velocity — slop, architectural friction, recurring pain. Quantify everything: counts, rates, dates, durations, file:line, issue numbers, session ids. Prefer 5-15 strong findings over a long tail; every finding cites concrete evidence. Save full notes to ${SP}/scout-<your-label>.md.
`

const FINDING = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    area: { type: 'string', description: 'package/subsystem' },
    problem: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'file:line, issue #, session id+date, CI run, metric value' },
    impact: { type: 'string', description: 'what it costs; quantified' },
    frequency: { type: 'string' },
    suggested_fix: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['title', 'area', 'problem', 'evidence', 'impact', 'confidence'],
}
const FINDINGS = {
  type: 'object',
  properties: { findings: { type: 'array', items: FINDING }, notes_file: { type: 'string' } },
  required: ['findings'],
}

const sessionMiner = (label, window) => ({
  label, tier: 'scout', needs: 'claude',
  prompt: `ASSIGNMENT: Mine agent session transcripts for recurring pain. Transcript dirs (JSONL, one file per session, subagent transcripts nested): ${(H.claude || []).join(', ')}. Only project dirs whose names contain one of: ${(H.match || []).join(', ')}. Window: ${window} (find -newermt).
Far too big to read: use rg/jq. Extract user messages (non-tool-result text) showing frustration or correction ("no", "wrong", "again", "why did", "stop", "broken", "flaky", "still failing"), tool_result errors that recur across sessions, repeated workarounds, commands that fail repeatedly (env setup, test runs, CI, typecheck, lockfile), and mentions of gotcha / workaround / hack / follow-up ticket / tech debt / slop. Count across sessions and rank. Read a handful of sessions deeply to understand the top 5 patterns. Report each with counts and example session paths and dates.`,
})

const LANES = [
  sessionMiner('sessions-recent', A.windows?.recent || 'last 14 days'),
  sessionMiner('sessions-mid', A.windows?.mid || '15-45 days ago'),
  sessionMiner('sessions-old', A.windows?.old || 'older than 45 days, sample broadly'),
  {
    label: 'codex-sessions', tier: 'scout', needs: 'codex',
    prompt: `ASSIGNMENT: Mine Codex CLI history at ${H.codex} (sessions/ JSONL by date, history.jsonl) for sessions whose cwd matches ${(H.match || []).join(' / ')}. Same method as a transcript miner: recurring errors, user corrections, repeated workarounds, failing commands, tasks that keep coming back. Count, rank, cite session files and dates.`,
  },
  {
    label: 'flaky-ci', tier: 'scout',
    prompt: `ASSIGNMENT: Tracker issues about flaky tests, CI failures, merge-queue parks, brittle tests and timeouts (${A.tracker}), open and closed, last ~6 months. Cluster by ROOT CAUSE (wall-clock, shared state, ordering, resource exhaustion, infra). Which tests/areas recur, how many reopen, how long open? From the CI provider (e.g. \`gh run list --limit 200 --json\`) compute failure rates of default-branch, queue and nightly runs over recent weeks and which jobs/steps fail most; sample failed job logs and classify infra vs real failure. Read park/bot comments for the stated reasons.`,
  },
  {
    label: 'followup-tickets', tier: 'scout',
    prompt: `ASSIGNMENT: Pull every open issue (${A.tracker}; e.g. gh issue list --state open --limit 1000 --json number,title,labels,body,createdAt). Many are agent-filed follow-ups and tech debt. CLUSTER them: which subsystems accumulate follow-ups, duplicates, tickets older than 60 days, tickets describing one architectural problem from different angles. Name the themes where one structural fix would close many tickets, with ticket numbers. Measure creation vs closure rate over 3 months, and the age mix of what actually gets closed vs what sits.`,
  },
  {
    label: 'encoded-debt', tier: 'scout',
    prompt: `ASSIGNMENT: Analyse the debt the repo already admits to: gotcha/troubleshooting docs, ADRs, glossary, agent docs (AGENTS.md/CLAUDE.md, skills), ratchet baselines (cycles, max-lines, complexity, coverage, lint suppressions), lint-disable counts, @ts-expect-error / any / unsafe casts, TODO/FIXME/HACK per package. Which documented workarounds still point at open fix tickets, and how old? Which areas have the most gotchas? Is the always-loaded docs surface itself too large for agents (measure bytes)? Quantify per package.`,
  },
  {
    label: 'prod-ops', tier: 'scout', needs: 'prod',
    prompt: `ASSIGNMENT: Production investigation through the \`${A.prod?.mcp}\` MCP, READ-ONLY (find tools by searching its name plus logs / metrics / traces / errors / pods). ${A.prod?.hint || ''} Last 7-14 days: top error log patterns per service, error-tracking issues by volume, alert rules firing or flapping (list only), pod restarts / OOMKills, slow endpoints and p95/p99, queue backlog and failed jobs. Map each recurring prod problem to the code that causes it (grep the repo) and estimate user impact.`,
  },
  {
    label: 'prod-data', tier: 'scout', needs: 'prod',
    prompt: `ASSIGNMENT: Database health through the \`${A.prod?.mcp}\` MCP: SELECT/EXPLAIN only (never EXPLAIN ANALYZE on writes). pg_stat_statements if available, pg_stat_user_tables (seq scans, dead tuples), unused/missing indexes, largest tables and growth, tables with no working retention, failing scheduled cleanup jobs (cross-check logs). Map each to the models/services that own it. Quantify.`,
  },
  {
    label: 'arch-backend', tier: 'reviewer',
    prompt: `ASSIGNMENT: Apply the \`improve-codebase-architecture\` and \`codebase-design\` skills (skip any grilling/interview loop; ask nobody anything) to the backend: ${A.areas?.backend}. Use git-log hot spots. Find shallow modules, leaky seams, god services, duplicated domain logic, missing deep modules, untestable areas, import cycles. Respect the ADRs. Mark each candidate Strong / Worth exploring / Speculative in its text.`,
  },
  {
    label: 'thermo-frontend', tier: 'reviewer',
    prompt: `ASSIGNMENT: Run the \`thermo-nuclear-code-quality-review\` skill against the CURRENT STATE (not a diff) of the frontend: ${A.areas?.frontend}. Hunt: files >1000 lines, spaghetti conditionals, duplicated components instead of the design system, inline components, duplicated hooks/queries, half-finished migrations leaving two of everything. Propose ambitious restructurings.`,
  },
  {
    label: 'thermo-tooling', tier: 'reviewer',
    prompt: `ASSIGNMENT: Run the \`thermo-nuclear-code-quality-review\` skill against the CURRENT STATE of dev tooling, CI and deploy: ${A.areas?.tooling}. Is the tooling becoming a second product with its own slop? Giant files, duplicated logic, ad-hoc branching, missing tests; compute tooling vs product effort from git log.`,
  },
  {
    label: 'deletion', tier: 'reviewer',
    prompt: `ASSIGNMENT: Apply the \`ponytail-review\` and \`ponytail\` lenses repo-wide: what should be DELETED? Dead code (run the repo's unused-code tool read-only if it has one), unused exports and deps, near-duplicate helpers across packages, speculative abstractions, reinvented stdlib, stale feature flags, dead legacy packages, comment slop (measure density per package), tests that assert nothing. Quantify removable LOC.`,
  },
  {
    label: 'churn-hotspots', tier: 'scout',
    prompt: `ASSIGNMENT: Git forensics over 6 months of the default branch: churn x size hot spots; bug magnets (files repeatedly touched by fix commits); reverts; PRs that needed chains of follow-up fixes; files >1000 lines and their growth; change coupling across package boundaries; fix-to-feature ratio per package; agent- vs human-authored commits (Co-Authored-By). Ranked list with numbers.`,
  },
  {
    label: 'test-health', tier: 'scout',
    prompt: `ASSIGNMENT: Test-suite health, static (run no heavy suites). Read the repo's testing docs. Measure tests per tier per package, slowest suites (from CI logs/reports), skip/only/retry usage, sleeps and hard-coded timing, integration tests that could be unit tests, duplicated helpers, snapshot bloat, end-to-end CI duration. Check whether the gates actually gate: does a suite that runs 0 tests pass? Is the slow tier ever green? Where does the pyramid hurt velocity most?`,
  },
  {
    label: 'security-deps', tier: 'scout',
    prompt: `ASSIGNMENT: Security and dependency hygiene. Run the package manager's audit (prod deps and full tree) read-only; check whether any CI job audits deps, scans secrets or runs SAST; whether dependency alerts are enabled; pinned versions holding back fixes; how long security update PRs wait. Read-only review of trust boundaries: internal APIs without auth, missing network policies, secrets in config, SSRF-prone outbound calls. Quantify.`,
  },
  {
    label: 'software-factory', tier: 'reviewer',
    prompt: `ASSIGNMENT: The repo is a "software factory": agents do most of the work through skills (repo skills/ and user-level skills), and debt is captured as follow-up tickets instead of fixed. Evaluate the factory itself: where does it generate slop (comment bloat, defensive code, duplicated helpers, ticket pile-up, oversized docs) and where does it burn time and tokens (merge-queue waits, CI reruns, environment setup, hand-rolled polling, refused tool calls, automatic reviews on every commit)? Where is a rule written in skill prose instead of enforced in code? WebSearch current practice (last 12 months) for keeping quality up in agent-heavy development: entropy/garbage-collection agents, fitness functions, ratchets, doc budgets, WIP limits. Recommend mechanisms grounded in what this repo already has.`,
  },
]

const skip = new Set(A.skip || [])
const available = l => !skip.has(l.label)
  && !(l.needs === 'claude' && !(H.claude || []).length)
  && !(l.needs === 'codex' && !H.codex)
  && !(l.needs === 'prod' && !A.prod?.mcp)
const lanes = [...LANES.filter(available), ...(A.extraLanes || [])]

phase('Gather')
const gathered = await parallel(lanes.map(l => () =>
  agent(`${COMMON}\n${l.prompt}`, { label: `scout:${l.label}`, phase: 'Gather', schema: FINDINGS, model: M[l.tier] })
    .then(r => r && ({ scout: l.label, ...r }))))
const ok = gathered.filter(Boolean)
log(`${ok.length}/${lanes.length} scouts returned, ${ok.reduce((n, r) => n + r.findings.length, 0)} raw findings`)

phase('Synthesize')
const CANDS = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'C01, C02, ...' },
          title: { type: 'string' },
          theme: { type: 'string', enum: ['architecture', 'reliability', 'test-ci', 'prod', 'dev-tooling', 'frontend', 'deletion', 'software-factory', 'data', 'security', 'process'] },
          problem: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          sources: { type: 'array', items: { type: 'string' } },
          hypothesis_fix: { type: 'string' },
          questions_to_verify: { type: 'array', items: { type: 'string' } },
        },
        required: ['id', 'title', 'theme', 'problem', 'evidence', 'sources', 'hypothesis_fix', 'questions_to_verify'],
      },
    },
  },
  required: ['candidates'],
}
const synth = await agent(`You are the synthesis lead of a codebase-health audit of ${A.project} (${A.repo}). Below are raw findings from ${ok.length} independent scouts. Their full notes are in ${SP}/scout-*.md — read them where a finding is thin.
Cluster and dedupe into ${A.candidates || '18-24'} CANDIDATE problems worth a deep dive. Merge findings that share a root cause seen from different angles — cross-source corroboration is the strongest signal, so record every source. Prefer root causes over symptoms and structural fixes that close many tickets or pain points at once. Drop weak, single-source, low-impact items. Cover a mix of themes.${A.previous ? `
A previous audit proposed the items below. Where a candidate is the same problem, reuse its id and title and say in the problem whether it got better or worse since (with the numbers); a problem fixed since is not a candidate.
PREVIOUS: ${JSON.stringify(A.previous)}` : ''} For each, list the questions a verifier must answer (measurements, reproductions, code reads).
RAW FINDINGS JSON:
${JSON.stringify(ok)}`, { label: 'synthesize', phase: 'Synthesize', schema: CANDS, model: M.lead })
log(`${synth.candidates.length} candidates`)

const MERMAID_RULES = 'Mermaid source only (no ``` fences). Use `flowchart TD` (it sits in a half-width pane, so top-down) or `sequenceDiagram`, at most 8 nodes, labels under 40 characters, node ids alphanumeric, every label in double quotes, no parentheses or semicolons outside quotes, no HTML. Real component/file/job names. Suffix failure-path nodes with `:::bad` and nodes the fix adds with `:::good` (the page defines both classes).'
const PROPOSAL = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string', description: 'one sentence: the defect and its consequence' },
    short: { type: 'string', description: '2-5 word name for the fix, e.g. "Batched events retention"' },
    verdict: { type: 'string', enum: ['confirmed', 'partially-confirmed', 'refuted'] },
    problem: { type: 'string', description: 'at most 70 words; the diagrams carry the mechanism' },
    cost_of_status_quo: { type: 'string', description: 'at most 60 words, with numbers' },
    evidence: { type: 'array', items: { type: 'string' } },
    metrics: { type: 'array', items: { type: 'string' }, description: 'measured numbers, plus the metric to track after the fix' },
    proposed_fix: { type: 'string', description: 'at most 90 words: modules/files, what moves, what is deleted' },
    why_better: { type: 'string', description: 'at most 50 words' },
    effort: { type: 'string', enum: ['S (<1 day)', 'M (1-3 days)', 'L (1-2 weeks)', 'XL (multi-week epic)'] },
    effort_detail: { type: 'string' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    risk_detail: { type: 'string' },
    breaking_change: { type: 'string', description: 'none / internal-only / API / data migration / plugin-author-facing — explain' },
    related_issues: { type: 'array', items: { type: 'string' } },
    first_step: { type: 'string', description: 'the smallest first PR' },
    adr_conflict: { type: 'string' },
    visual: {
      type: 'object',
      description: 'Pictures for the report card. A reader should grasp the problem and the fix from these before reading any prose.',
      properties: {
        before: { type: 'string', description: `Diagram of how it works or fails TODAY, failure path marked. ${MERMAID_RULES}` },
        after: { type: 'string', description: `The SAME diagram after the fix, same node ids where they survive. ${MERMAID_RULES}` },
        numbers: {
          type: 'array',
          description: '2-5 measured quantities as now vs target after the fix (same unit per row)',
          items: {
            type: 'object',
            properties: { label: { type: 'string' }, now: { type: 'number' }, target: { type: 'number' }, unit: { type: 'string' }, better: { type: 'string', enum: ['lower', 'higher'] } },
            required: ['label', 'now', 'target', 'unit', 'better'],
          },
        },
        footprint: {
          type: 'object',
          description: 'estimated size of the full fix',
          properties: { files: { type: 'number' }, loc_added: { type: 'number' }, loc_removed: { type: 'number' } },
          required: ['files', 'loc_added', 'loc_removed'],
        },
      },
      required: ['before', 'after', 'numbers', 'footprint'],
    },
  },
  required: ['id', 'title', 'short', 'verdict', 'problem', 'cost_of_status_quo', 'evidence', 'metrics', 'proposed_fix', 'why_better', 'effort', 'risk', 'breaking_change', 'first_step', 'visual'],
}
const CHALLENGE = {
  type: 'object',
  properties: {
    holds_up: { type: 'boolean' },
    severity_adjust: { type: 'string', enum: ['raise', 'keep', 'lower', 'drop'] },
    claims_checked: {
      type: 'array',
      description: 'each load-bearing factual claim of the proposal you checked yourself',
      items: {
        type: 'object',
        properties: { claim: { type: 'string' }, status: { type: 'string', enum: ['held', 'corrected', 'refuted', 'unverified'] }, note: { type: 'string' } },
        required: ['claim', 'status'],
      },
    },
    objections: { type: 'array', items: { type: 'string' } },
    factual_errors: { type: 'array', items: { type: 'string' } },
    better_alternative: { type: 'string' },
    effort_risk_correction: { type: 'string' },
    priority_score: { type: 'number', description: '1-10 value/effort priority after challenge' },
  },
  required: ['holds_up', 'severity_adjust', 'claims_checked', 'objections', 'priority_score'],
}

const results = await pipeline(
  synth.candidates,
  c => agent(`${COMMON}
ASSIGNMENT: Deep-dive ONE candidate problem. Verify it against the code, git history, the tracker, CI data and (where relevant) production telemetry, all read-only. Measure what you can (call sites, LOC, durations, failure rates, ticket counts). Cheap host-side read-only checks (grep, a package typecheck, host-runnable unit tests) are fine for reproducing assumptions. Design the fix with the codebase-design vocabulary (deep modules, seams) and the ponytail principle (smallest complete change; prefer deletion). Respect the ADRs; if the fix contradicts one, name it and say why reopening it pays. If the problem is overstated, say partially-confirmed or refuted.
Fill \`visual\` with care: it is the first thing the reader sees. \`before\` and \`after\` are the same diagram, so the difference IS the fix. Keep prose fields inside their word limits.
CANDIDATE:
${JSON.stringify(c, null, 2)}`, { label: `dive:${c.id}`, phase: 'Deep-dive', schema: PROPOSAL, model: M.dive }),
  (p, c) => p && agent(`You are an adversarial senior reviewer of ${A.project} (${A.repo}). ${A.engineerSkill ? `Invoke the \`${A.engineerSkill}\` skill first. ` : ''}READ-ONLY. Try hard to REFUTE or downgrade this proposal: check each load-bearing claim yourself against the code, tracker and history (record each in claims_checked), look for cheaper alternatives, hidden risk, understated effort, missed breaking changes, ADRs it violates, and whether the status quo really costs that much. Default to skepticism; if it holds up, say so.
PROPOSAL:
${JSON.stringify(p, null, 2)}`, { label: `skeptic:${c.id}`, phase: 'Challenge', schema: CHALLENGE, model: M.skeptic })
    .then(ch => ({ candidate: { id: c.id, theme: c.theme, sources: c.sources }, proposal: p, challenge: ch })),
)
const done = results.filter(Boolean)

phase('Critic')
const critic = await agent(`You are the completeness critic of a codebase-health audit of ${A.project} (${A.repo}). Scout notes are in ${SP}/scout-*.md. Below are the verified proposals. Which important problem areas are MISSING or under-covered (security, data model, performance, observability, extension/plugin system, billing, integrations, frontend performance, dependency hygiene, cost, the human review queue)? Which evidence sources went unused? Investigate the top 3-5 gaps yourself, read-only, and return them as findings with evidence. Also flag proposals that conflict or must be sequenced, one line each ("A before B: reason").
PROPOSALS:
${JSON.stringify(done.map(d => ({ id: d.proposal.id, title: d.proposal.title, verdict: d.proposal.verdict, score: d.challenge?.priority_score })))}`,
  { label: 'critic', phase: 'Critic', model: M.lead, schema: {
    type: 'object',
    properties: { gaps: FINDINGS.properties.findings, conflicts_and_sequencing: { type: 'array', items: { type: 'string' } } },
    required: ['gaps', 'conflicts_and_sequencing'],
  } })

return { scouts: ok.map(s => ({ scout: s.scout, n: s.findings.length })), candidates: synth.candidates, results: done, critic }
