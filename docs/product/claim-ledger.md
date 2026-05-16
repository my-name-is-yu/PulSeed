# Product Claim Ledger

> Status: Machine-checkable product boundary document. `npm run check:docs`
> parses the fenced JSON in this file and validates source text plus evidence
> references.

This ledger keeps selected high-risk public docs claims tied to implementation
evidence or explicit boundary language. It does not prove every sentence in the
docs; it marks the claims most likely to blur current behavior, operator/debug
behavior, product direction, and unsupported overclaim territory.

```json
{
  "schema_version": "pulseed-product-claim-ledger/v1",
  "audit_scope": [
    "README.md",
    "docs/start",
    "docs/operate",
    "docs/reference",
    "docs/product",
    "docs/design"
  ],
  "claims": [
    {
      "id": "readme-current-long-running-goal-runtime",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "README.md",
        "text": "The current implementation focuses on long-running goal orchestration."
      },
      "claim": "PulSeed currently implements long-running goal orchestration.",
      "evidence_refs": [
        "src/orchestrator/loop/durable-loop.ts",
        "src/orchestrator/execution/agent-loop/task-agent-loop-runner.ts",
        "package.json#scripts.test:contracts"
      ]
    },
    {
      "id": "readme-companion-design-direction",
      "classification": "design_only_or_future_direction",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "README.md",
        "text": "design direction: remembering what matters, noticing when the situation"
      },
      "claim": "PulSeed is publicly positioned toward companion software beyond current task execution.",
      "evidence_refs": [
        "docs/product/positioning.md",
        "docs/product/vision.md",
        "docs/design/product/product-spine.md"
      ]
    },
    {
      "id": "readme-turnkey-life-automation-not-current",
      "classification": "unsupported_overclaim",
      "claim_kind": "negative_boundary",
      "source": {
        "path": "README.md",
        "text": "a turnkey personal-life automation product"
      },
      "claim": "PulSeed does not claim turnkey personal-life automation as current behavior."
    },
    {
      "id": "start-pulseed-home-isolation",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/start/index.md",
        "text": "`PULSEED_HOME` when you need an isolated state directory for testing or"
      },
      "claim": "PulSeed can use PULSEED_HOME for isolated local state.",
      "evidence_refs": [
        "src/base/utils/paths.ts",
        "scripts/verify-packaged-artifacts.mjs",
        "package.json#scripts.verify:packaged-artifacts"
      ]
    },
    {
      "id": "start-state-root-db-first-boundary",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/start/index.md",
        "text": "files under `~/.pulseed/` by default. Durable runtime truth is DB-first; do"
      },
      "claim": "The state root contains many files, but durable runtime truth is DB-first.",
      "evidence_refs": [
        "scripts/check-database-first-legacy-stores.mjs",
        "package.json#scripts.check:database-first-legacy-stores",
        "docs/reference/runtime-state.md"
      ]
    },
    {
      "id": "start-sandbox-not-complete",
      "classification": "unsupported_overclaim",
      "claim_kind": "negative_boundary",
      "source": {
        "path": "docs/start/index.md",
        "text": "are not an OS sandbox. Shell commands, local backends, provider tools, and"
      },
      "claim": "PulSeed approval and verification gates are not a complete OS sandbox."
    },
    {
      "id": "operate-status-recommended-current-path",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operate/status.md",
        "text": "Use these first when you want the current, best-supported path:"
      },
      "claim": "Status docs distinguish recommended current behavior from advanced/operator surfaces.",
      "evidence_refs": [
        "docs/operate/status.md",
        "src/interface/cli/cli-runner.ts",
        "package.json#scripts.test:smoke"
      ]
    },
    {
      "id": "operate-status-operator-interfaces",
      "classification": "operator_debug_behavior",
      "claim_kind": "operator_surface",
      "source": {
        "path": "docs/operate/status.md",
        "text": "These surfaces exist, but they are better treated as operator or integration"
      },
      "claim": "Daemon, schedules, gateways, plugins, skills, profile, usage, and diagnostics include operator/integration surfaces.",
      "evidence_refs": [
        "src/interface/cli/cli-command-registry.ts",
        "src/runtime/daemon/runner.ts",
        "src/runtime/gateway/ingress-gateway.ts"
      ]
    },
    {
      "id": "operate-runtime-personal-agent-diagnostics",
      "classification": "operator_debug_behavior",
      "claim_kind": "operator_surface",
      "source": {
        "path": "docs/operate/runtime.md",
        "text": "The personal-agent diagnostic commands inspect the durable decision trace:"
      },
      "claim": "Personal-agent trace inspection is an operator/debug surface.",
      "evidence_refs": [
        "src/interface/cli/commands/runtime.ts",
        "src/runtime/personal-agent/store.ts",
        "tests/contracts/personal-agent-runtime.test.ts"
      ]
    },
    {
      "id": "reference-cli-current-command-surface",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/reference/cli.md",
        "text": "This page lists the current `pulseed` command surface."
      },
      "claim": "The CLI reference is intended to track the current command registry.",
      "evidence_refs": [
        "src/interface/cli/cli-command-registry.ts",
        "src/interface/cli/cli-runner.ts"
      ]
    },
    {
      "id": "reference-runtime-state-truth-boundary",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/reference/runtime-state.md",
        "text": "Current durable runtime state is owned by typed SQLite/Soil/control DB stores."
      },
      "claim": "Runtime-state docs define DB-first state ownership.",
      "evidence_refs": [
        "scripts/check-database-first-legacy-stores.mjs",
        "package.json#scripts.check:database-first-legacy-stores",
        "docs/design/operations/verification-doc-truth.md"
      ]
    },
    {
      "id": "reference-runtime-state-personal-agent-trace",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/reference/runtime-state.md",
        "text": "The current durable personal-agent runtime trace is stored in the control DB,"
      },
      "claim": "The durable personal-agent trace is stored in the control DB and covers production decisions.",
      "evidence_refs": [
        "src/runtime/store/control-db/schema.ts",
        "src/runtime/personal-agent/store.ts",
        "src/runtime/personal-agent/goal-run-admission-trace.ts",
        "tests/contracts/personal-agent-runtime.test.ts"
      ]
    },
    {
      "id": "product-matrix-scenario-classes",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/product/completion-matrix.md",
        "text": "were audited into current, operator/debug, design-only, boundary, or unsupported"
      },
      "claim": "The product matrix and claim ledger classify public claims by behavior boundary.",
      "evidence_refs": [
        "docs/product/completion-matrix.md",
        "docs/product/claim-ledger.md",
        "package.json#scripts.check:docs"
      ]
    },
    {
      "id": "product-vision-examples-design-only",
      "classification": "design_only_or_future_direction",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/product/vision.md",
        "text": "The examples in this section describe product design direction, not complete workflows"
      },
      "claim": "Vision examples are design direction rather than complete current workflows.",
      "evidence_refs": [
        "docs/product/vision.md",
        "docs/operate/status.md"
      ]
    },
    {
      "id": "product-vision-advice-boundary",
      "classification": "unsupported_overclaim",
      "claim_kind": "negative_boundary",
      "source": {
        "path": "docs/product/vision.md",
        "text": "available in the current package. They are not medical, veterinary, financial,"
      },
      "claim": "PulSeed docs explicitly reject medical, veterinary, financial, legal, and business advice overclaims."
    },
    {
      "id": "product-positioning-implemented-foundation",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/product/positioning.md",
        "text": "PulSeed's current strongest implementation foundation is long-running goal"
      },
      "claim": "PulSeed's current implementation foundation is long-running goal orchestration.",
      "evidence_refs": [
        "src/orchestrator/loop/durable-loop.ts",
        "src/runtime/daemon/runner.ts",
        "src/interface/chat/chat-runner.ts"
      ]
    },
    {
      "id": "product-positioning-agentic-friend-contract",
      "classification": "design_only_or_future_direction",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/product/positioning.md",
        "text": "PulSeed's product contract is durable everyday companionship:"
      },
      "claim": "Durable everyday companionship is product direction beyond the current wedge.",
      "evidence_refs": [
        "docs/product/positioning.md",
        "docs/design/product/product-spine.md",
        "docs/operate/status.md"
      ]
    },
    {
      "id": "design-db-first-runtime-truth",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/design/runtime/control-daemon-eventing.md",
        "text": "Typed SQLite/control stores own current runtime truth; file and debug exports"
      },
      "claim": "Design docs preserve the DB-first runtime truth boundary.",
      "evidence_refs": [
        "scripts/check-database-first-legacy-stores.mjs",
        "package.json#scripts.check:database-first-legacy-stores",
        "docs/reference/runtime-state.md"
      ]
    },
    {
      "id": "design-soil-runtime-store-boundary",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/design/knowledge/soil-dream-learning.md",
        "text": "Runtime stores remain authoritative for writes; Soil is a typed retrieval and"
      },
      "claim": "Soil is a retrieval/publication surface, not the write authority for current runtime state.",
      "evidence_refs": [
        "src/platform/soil/index.ts",
        "docs/reference/runtime-state.md"
      ]
    }
  ]
}
```
