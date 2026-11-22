# Skills

[![skills.sh](https://skills.sh/b/niekcandaele/skills)](https://skills.sh/niekcandaele/skills)

My development flow, written down as agent skills.

```bash
npx skills add niekcandaele/skills --list   # see what's here
npx skills add niekcandaele/skills          # pick what you want
```

Take one skill, take the lot, or copy the files straight into your own repo and
edit them.

## Harnesses

The prose in these skills assumes no specific agent runtime. Where a skill needs a
real capability — spawning sub-agents, running background commands — it says so
and names a concrete binding as an example rather than depending on it.

Frontmatter is a different matter: keys like `allowed-tools`, `context` and
`argument-hint` are each harness's own interface, and the tool names inside them
are specific. Harnesses ignore keys they don't recognize, so this costs you
nothing, but it does mean the files aren't runtime-agnostic all the way down.

Some skills also ask more than others. `verify` and `epic-runner` are much faster
where sub-agents run in parallel, though both document what to do when they can't.
`second-model-reviewer` shells out to a second model's CLI and needs one installed and
logged in — Antigravity (`agy`) or Codex; it picks and remembers one per machine.

## Development

```bash
just validate    # layout, frontmatter, groupings, declared dependencies
just structure   # show the tree
just try --list  # install from this checkout to try it
```

`just validate` needs `python3` with `pyyaml`, plus `jq`. It runs in CI on every
pull request.

