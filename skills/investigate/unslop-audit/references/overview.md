# overview.json

The orchestrator's half of the page. The workflow output holds the machine half: proposals, skeptic challenges, and critic gaps. This file holds the judgement: what the numbers mean, the order of work, and the rules. `build-page.mjs` merges the two. A complete example from a real run is in [`example-overview.json`](example-overview.json).

Picture-first: every number you cite becomes a stat tile or a chart. Prose lives in captions and stays under 40 words. A section left empty is removed from the page.

```jsonc
{
  "meta": {
    "title": "Acme Unslop Audit",              // 2-4 words, also the <title>
    "eyebrow": "org/repo · unslop audit · 2026-11-07",
    "repo_url": "https://github.com/org/repo",  // turns "#123" refs into issue links
    "lede": "≤ 90 words: what was searched, how many proposals, the one-line diagnosis.",
    "method": "Footer: lanes, models by tier, what stayed read-only.",
    "facts": [["16", "scouts"]]                 // optional; computed from the output when absent
  },
  "themes": [{ "key": "ci", "label": "CI & tests" }],  // ≤ 10, order picks palette slots t1..t10
  "theme_of": { "C01": "ci" },                 // optional; defaults to the synthesis theme
  "short":    { "C01": "Resilient CI pod run" }, // optional; defaults to the deep-dive's short name
  "stats": [{ "n": "0/21", "text": "nightly runs green", "source": "C02 · gh run list", "theme": "bad" }],
  "charts": [{
    "title": "Why heavy CI lanes fail",
    "caption": "Sample, window, and which proposals it backs. `code` and **bold** work.",
    "type": "bar",                              // bar | doughnut | line
    "horizontal": false, "stacked": false, "log": false, "unit": "%", "max": 100,
    "labels": ["a", "b"],
    "datasets": [{ "label": "jobs", "data": [3, 5], "color": "bad" }] // color: one value, or one per label
  }],
  "waves": [{ "tag": "Wave 0 · this week · all S", "title": "Stop the bleeding",
              "items": [{ "ref": "C20", "text": "One line: the action." }] }], // ref links to the card
  "sequence": "flowchart LR ...",              // mermaid dependency graph between waves/proposals
  "rules": [{ "title": "Gates live in code", "text": "The principle.", "evidence": "Numbers + proposal ids." }]
}
```

Colors (`theme` on a stat, `color` on a dataset) take a tone (`bad`, `warn`, `good`, `muted`, `line`, `accent`, `fg`) or a theme key. Use tones for meaning (red is waste, green is useful) and theme keys to tie a figure to its area.

The page adds two charts of its own from the skeptic data: how scores moved, and how many claims held. Don't author those.

Choosing what goes where:

- **stats**: 8-10 figures that would each start a conversation alone. One per proposal at most, strongest first.
- **charts**: 4-6. Each one compares something: useful vs waste, now vs then, cause shares. A single number belongs in a stat.
- **waves**: order by the critic's `conflicts_and_sequencing`, then by score per effort. Wave 0 is small, safe, and stops active damage. Put security gaps from the critic into a wave too.
- **rules**: 5-7 cross-cutting patterns that several proposals share, each phrased as a mechanism (a check, a budget, a WIP limit), never an exhortation.
