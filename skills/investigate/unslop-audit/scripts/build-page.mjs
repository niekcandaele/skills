#!/usr/bin/env node
// Merge a finished audit (workflow output) with the orchestrator's overview into one HTML page.
// usage: node build-page.mjs --output <workflow-output.json> --overview <overview.json> --out <page.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'

const arg = name => {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`)
  return process.argv[i + 1]
}
const here = dirname(fileURLToPath(import.meta.url))
const raw = JSON.parse(readFileSync(arg('output'), 'utf8'))
const run = raw.result ?? raw
const ov = JSON.parse(readFileSync(arg('overview'), 'utf8'))

const unfence = s => (s || '').replace(/^\s*```(?:mermaid)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim()
const titleCase = s => s.replace(/(^|-)(\w)/g, (_, d, c) => (d ? ' ' : '') + c.toUpperCase())

const proposals = run.results.map(({ candidate = {}, proposal: p, challenge: ch = {} }) => ({
  id: p.id,
  short: ov.short?.[p.id] ?? p.short ?? p.title,
  theme: ov.theme_of?.[p.id] ?? candidate.theme,
  title: p.title,
  verdict: p.verdict,
  score: ch.priority_score ?? 0,
  adj: ch.severity_adjust ?? '',
  effort: p.effort,
  risk: p.risk,
  breaking: p.breaking_change,
  problem: p.problem,
  cost: p.cost_of_status_quo,
  metrics: p.metrics,
  fix: p.proposed_fix,
  why: p.why_better,
  first: p.first_step,
  adr: p.adr_conflict,
  alt: ch.better_alternative,
  correction: ch.effort_risk_correction,
  objections: [...(ch.objections || []), ...(ch.factual_errors || []).map(e => `Factual error: ${e}`)],
  issues: p.related_issues,
  claims: ch.claims_checked,
  visual: p.visual && { ...p.visual, before: unfence(p.visual.before), after: unfence(p.visual.after) },
}))

const themes = ov.themes ?? [...new Set(proposals.map(p => p.theme))].map(key => ({ key, label: titleCase(key) }))
const known = new Set(themes.map(t => t.key))
const orphan = proposals.filter(p => !known.has(p.theme)).map(p => `${p.id}:${p.theme}`)
if (orphan.length) throw new Error(`proposals with a theme missing from overview.themes: ${orphan.join(', ')}`)

const rawFindings = (run.scouts || []).reduce((n, s) => n + s.n, 0)
const facts = ov.meta.facts ?? [
  [run.scouts?.length, 'scouts'],
  [rawFindings, 'raw findings'],
  [proposals.length, 'verified proposals'],
  raw.agentCount && [raw.agentCount, 'agents'],
  raw.totalTokens && [`${(raw.totalTokens / 1e6).toFixed(1)}M`, 'tokens'],
].filter(Boolean)

const data = {
  meta: { ...ov.meta, facts },
  themes,
  stats: ov.stats,
  charts: ov.charts,
  waves: ov.waves,
  sequence: unfence(ov.sequence),
  rules: ov.rules,
  proposals,
  gaps: (run.critic?.gaps || []).map(g => ({ title: g.title, area: g.area, confidence: g.confidence, problem: g.problem, impact: g.impact, evidence: g.evidence, fix: g.suggested_fix })),
}

const json = JSON.stringify(data).replace(/</g, '\\u003c')
const html = readFileSync(join(here, '../assets/report-template.html'), 'utf8')
  .replace('__TITLE__', () => ov.meta.title.replace(/[<&]/g, ''))
  .replace('__DATA__', () => json)

const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)[1]
new Script(inlineScript)
writeFileSync(arg('out'), html)

const noVisual = proposals.filter(p => !p.visual?.before || !p.visual?.after).map(p => p.id)
console.log(`wrote ${arg('out')}: ${proposals.length} proposals, ${data.gaps.length} gaps, ${(html.length / 1024).toFixed(0)} KB`)
if (noVisual.length) console.log(`proposals without before/after diagrams: ${noVisual.join(', ')}`)
