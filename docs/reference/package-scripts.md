# Package Scripts

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
npm run test:all
npm run test:changed
npm run test:watch
npm run test:watch:integration
npm run test:runtime-long-run
```

Specialized lanes:

```bash
npm run test:memory-correction-eval
npm run test:lifelong-agent-eval
npm run test:dogfood
npm run test:kaggle-training
```

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
