# Lanes

A lane is one scout with one evidence source. This file lists starting points to choose from, not a set to run in full. Pick a lane only when this repo actually has its source. Write each prompt for this repo: name the exact paths, commands, MCP name and date range, and say what to count. Invent lanes the menu lacks whenever the product has its own evidence, such as a plugin ecosystem, a billing system, or support tickets.

Each lane is `{ label, tier, prompt }`. `tier` is `scout` (mid-tier model; counting and grepping) or `reviewer` (strong model; judgement over code). The script adds the read-only rules and the output format.

## History: what agents and humans struggled with

- **Agent transcripts**, one lane per date window (for example the last 14 days, 15-45 days, and older, sampled). Point the lane at every transcript store on the machine: all harness accounts, with symlinks resolved and duplicates removed, filtered to this repo's project dirs. Use rg/jq, never full reads. Count user corrections and frustration, recurring tool errors, repeated workarounds, and commands that fail again and again. Then read a few sessions in depth to explain the top patterns.

## Tracker: what the team already wrote down

- **Flaky CI**: issues about flaky or brittle tests, plus the CI provider's run history. Cluster by root cause. Report failure rates per branch and job, and the split between infrastructure and real failures.
- **Follow-up tickets**: every open issue. Group them into themes where one structural fix would close many. Measure creation vs closure rates and the age of what gets closed.

## Code: what the repo admits and hides

- **Encoded debt**: gotcha docs, ADRs, agent docs, ratchet baselines, lint suppressions, TODO/HACK counts per package, and workarounds that point at open fix tickets.
- **Architecture** (`reviewer`): shallow modules, leaky seams, god services, duplicated domain logic. Pair with `improve-codebase-architecture` / `codebase-design` when installed.
- **Thermo-nuclear review** (`reviewer`), one lane per large area (for example frontend, or tooling and CI): giant files, spaghetti conditionals, half-finished migrations. Use `thermo-nuclear-code-quality-review` when installed.
- **Deletion** (`reviewer`): dead code, unused exports and deps, near-duplicates, speculative abstractions, comment slop. Quantify the LOC that can go. Use `ponytail-review` when installed.
- **Churn hot spots**: six months of git. Churn × size, bug magnets, reverts, follow-up fix chains, and change coupling across package boundaries.
- **Test health**: static only. Tests per tier, slowest suites, skips and retries, sleeps, and whether the gates actually gate (does a suite that runs 0 tests still pass?).

## Runtime: what production says

- **Ops**, through a read-only observability MCP: top error patterns, error-tracking volume, flapping alerts, restarts, slow endpoints. Map each problem to the code that causes it. List which of the MCP's tools mutate, and forbid them in the prompt.
- **Data**: SELECT/EXPLAIN only. Slow statements, unused or missing indexes, table growth, and retention that does not work.

## Process: how the work gets done

- **Security and dependencies**: run the package manager's audit read-only, check for CI scanning, look for pins that hold back fixes, and review trust boundaries.
- **The factory** (`reviewer`), for agent-heavy repos: where agents generate slop or burn time and tokens, and which rules live in prose instead of code. Ground the recommendations in current practice (ratchets, fitness functions, WIP limits).
