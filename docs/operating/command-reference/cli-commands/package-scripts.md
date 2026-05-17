# Package Scripts

> Status: Current package-scripts reference. This page lists maintained scripts for contributors and release verification.

This page lists maintained npm scripts that are useful for contributors and
release verification.

## Build And Docs

```bash
npm run build
npm run build:watch
npm run check:docs
npm run verify:packaged-artifacts
```

`npm run check:docs` scans Markdown files for unresolved merge markers,
unbalanced triple-backtick fences, and missing local Markdown links.

## Tests

```bash
npm test
npm run test:unit
npm run test:smoke
npm run test:integration
npm run test:contracts
npm run test:golden-traces
npm run test:replay
npm run test:product-gauntlet
npm run test:all
npm run test:changed
npm run test:watch
npm run test:watch:integration
npm run test:runtime-long-run
```

Specialized lanes:

```bash
npm run check:database-first-legacy-stores
npm run check:public-contracts
npm run test:memory-correction-eval
npm run test:lifelong-agent-eval
npm run test:dogfood
npm run test:kaggle-training
```

`npm run test:product-gauntlet` runs the local Interaction Authority product
gauntlet. It uses temp runtime roots, fake providers/transports, fixture DBs,
and no real Telegram, network, LLM, or user secrets. The lane covers
representative authority regressions: Telegram peer delivery, stale callback
rejection, callback failure offset progress, digest-only holds, old approval
rejection, quiet-mode notification suppression, memory correction propagation,
ToolExecutor non-execution, replay dedupe, and normal-surface redaction. Set
`PULSEED_PRODUCT_GAUNTLET_DEBUG=1` to write local failure artifacts under
`tmp/eval-failures/<scenario-id>/`.

`npm run check:public-contracts` expects built `dist/` artifacts to exist. It
checks package exports, package contents, the Surface Projection Protocol
normal-surface boundary guard, and companion cognition boundaries.

## Runtime And Smoke Checks

```bash
npm run tui
npm run tui:test
npm run smoke:gateway-direct-chat-latency
npm run dogfood:agentloop:real
```

## Lint, Typecheck, Release

```bash
npm run typecheck
npm run lint:boundaries
npm run lint:quality
npm run audit:prod
npm run verify:release
npm run release
npm run pack:dry-run
```

Release work has additional process requirements. See the release workflow
before running release commands.
