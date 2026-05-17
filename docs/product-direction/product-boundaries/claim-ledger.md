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
  "audited_at": "2026-05-15",
  "audit_scope": [
    "README.md",
    "docs/getting-started",
    "docs/operating",
    "docs/product-direction",
    "docs/runtime-architecture",
    "docs/knowledge-memory"
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
      "claim": "The current package focuses on long-running goal orchestration rather than the full companion-product direction.",
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
      "claim": "Companion-software behavior is product direction layered on the current long-running runtime.",
      "evidence_refs": [
        "docs/product-direction/product-framing/positioning.md",
        "docs/product-direction/product-framing/vision.md"
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
      "claim": "PulSeed does not currently claim turnkey personal-life automation."
    },
    {
      "id": "start-pulseed-home-isolation",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/getting-started/first-run.md",
        "text": "`PULSEED_HOME` when you need an isolated state directory for testing or"
      },
      "claim": "First-run and automation flows can isolate local state with PULSEED_HOME.",
      "evidence_refs": [
        "src/base/utils/paths.ts",
        "scripts/verify-packaged-artifacts.mjs",
        "package.json#scripts.verify:packaged-artifacts"
      ]
    },
    {
      "id": "start-live-cloud-providers-need-credentials",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/getting-started/first-run.md",
        "text": "configuration when none exists. OpenAI, Anthropic, and Ollama paths are"
      },
      "claim": "Live provider credentials are configuration boundaries, not package smoke-test requirements.",
      "evidence_refs": [
        "src/base/llm/provider-config.ts",
        "src/base/llm/provider-factory.ts",
        "src/interface/cli/commands/setup/steps-provider.ts"
      ]
    },
    {
      "id": "start-state-root-db-first-boundary",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/getting-started/first-run.md",
        "text": "files under `~/.pulseed/` by default. Durable runtime truth is DB-first; do"
      },
      "claim": "The first-run guide distinguishes the local state root from authoritative runtime JSON ownership.",
      "evidence_refs": [
        "scripts/check-database-first-legacy-stores.mjs",
        "package.json#scripts.check:database-first-legacy-stores",
        "docs/operating/runtime-operations/runtime-state.md"
      ]
    },
    {
      "id": "start-sandbox-not-complete",
      "classification": "unsupported_overclaim",
      "claim_kind": "negative_boundary",
      "source": {
        "path": "docs/getting-started/first-run.md",
        "text": "are not an OS sandbox. Shell commands, local backends, provider tools, and"
      },
      "claim": "PulSeed does not claim complete operating-system sandboxing for local backends, tools, and plugins."
    },
    {
      "id": "operate-status-recommended-current-path",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operating/runtime-operations/status.md",
        "text": "Use these first when you want the current, best-supported path:"
      },
      "claim": "The status page explicitly separates recommended current paths from advanced/operator and evolving surfaces.",
      "evidence_refs": [
        "docs/operating/runtime-operations/status.md",
        "src/interface/cli/cli-runner.ts",
        "package.json#scripts.test:smoke"
      ]
    },
    {
      "id": "operate-status-operator-interfaces",
      "classification": "operator_debug_behavior",
      "claim_kind": "operator_surface",
      "source": {
        "path": "docs/operating/runtime-operations/status.md",
        "text": "These surfaces exist, but they are better treated as operator or integration"
      },
      "claim": "Daemon, schedule, gateway, plugin, memory, profile, usage, and runtime diagnostics are operator/integration-facing surfaces.",
      "evidence_refs": [
        "src/interface/cli/cli-command-registry.ts",
        "src/runtime/daemon/runner.ts",
        "src/runtime/gateway/ingress-gateway.ts"
      ]
    },
    {
      "id": "operate-status-normal-surface-redaction",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operating/runtime-operations/status.md",
        "text": "readiness, admission, autonomy, capability catalog, warning, rationale, or"
      },
      "claim": "Normal user-facing projections must hide raw internal readiness, admission, autonomy, capability, policy, and evidence details.",
      "evidence_refs": [
        "tests/contracts/product-completion-gauntlet.test.ts",
        "src/runtime/gateway/non-tui-display-projector.ts",
        "src/interface/current-goal-summary.ts"
      ]
    },
    {
      "id": "operate-runtime-diagnostics-operator",
      "classification": "operator_debug_behavior",
      "claim_kind": "operator_surface",
      "source": {
        "path": "docs/operating/runtime-operations/runtime.md",
        "text": "Runtime diagnostics expose sessions, background runs, evidence, budgets, and"
      },
      "claim": "Runtime diagnostics may expose raw operator state and are not normal chat/status projections.",
      "evidence_refs": [
        "src/interface/cli/commands/runtime.ts",
        "src/runtime/session-registry/index.ts"
      ]
    },
    {
      "id": "operate-runtime-personal-agent-diagnostics",
      "classification": "operator_debug_behavior",
      "claim_kind": "operator_surface",
      "source": {
        "path": "docs/operating/runtime-operations/runtime.md",
        "text": "The personal-agent diagnostic commands inspect the durable decision trace:"
      },
      "claim": "Personal-agent trace inspection commands are diagnostic/operator surfaces, not normal chat/status output.",
      "evidence_refs": [
        "src/interface/cli/commands/runtime.ts",
        "src/runtime/personal-agent/store.ts",
        "tests/contracts/personal-agent-runtime.test.ts"
      ]
    },
    {
      "id": "operate-runtime-current-gateway-channels",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operating/runtime-operations/runtime.md",
        "text": "Core builtin gateway channel names are:"
      },
      "claim": "The runtime docs list current builtin gateway channel names instead of claiming every gateway integration is first-class.",
      "evidence_refs": [
        "src/runtime/gateway/builtin-channel-names.ts",
        "src/runtime/gateway/builtin-channel-integrations.ts"
      ]
    },
    {
      "id": "operate-config-code-defaults",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operating/runtime-operations/configuration.md",
        "text": "The provider-config code default is:"
      },
      "claim": "Provider defaults and setup recommendations are intentionally separated.",
      "evidence_refs": [
        "src/base/llm/provider-config.ts",
        "src/base/llm/provider-config-models.ts"
      ]
    },
    {
      "id": "operate-config-worktree-not-os-sandbox",
      "classification": "unsupported_overclaim",
      "claim_kind": "negative_boundary",
      "source": {
        "path": "docs/operating/runtime-operations/configuration.md",
        "text": "an OS sandbox. For untrusted goals, use Docker, a containerized PulSeed process,"
      },
      "claim": "Native AgentLoop worktree isolation is not documented as full OS sandboxing."
    },
    {
      "id": "reference-cli-current-command-surface",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operating/command-reference/cli-commands/cli.md",
        "text": "This page lists the current `pulseed` command surface."
      },
      "claim": "The CLI reference is a current command-surface reference, not product direction.",
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
        "path": "docs/operating/runtime-operations/runtime-state.md",
        "text": "Current durable runtime state is owned by typed SQLite/Soil/control DB stores."
      },
      "claim": "Runtime state reference classifies legacy JSON/JSONL/lock/sidecar/raw fallback paths as non-authoritative except for explicit boundaries.",
      "evidence_refs": [
        "scripts/check-database-first-legacy-stores.mjs",
        "package.json#scripts.check:database-first-legacy-stores",
        "docs/runtime-architecture/state-reliability/database-first-state-ownership.md"
      ]
    },
    {
      "id": "reference-runtime-state-personal-agent-trace",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/operating/runtime-operations/runtime-state.md",
        "text": "The current durable personal-agent runtime trace is stored in the control DB,"
      },
      "claim": "The control DB stores the current personal-agent SituationFrame, InitiativeEvent, attention, candidate, policy, RuntimeGraph, and memory provenance trace.",
      "evidence_refs": [
        "src/runtime/store/control-db/schema.ts",
        "src/runtime/personal-agent/store.ts",
        "src/runtime/personal-agent/goal-run-admission-trace.ts",
        "src/runtime/schedule/personal-agent-trace.ts",
        "src/runtime/schedule/notification-report.ts",
        "src/runtime/store/outbox-store.ts",
        "src/platform/corrections/user-memory-operations.ts",
        "src/platform/knowledge/knowledge-manager-agent-memory.ts",
        "src/grounding/providers/soil-provider.ts",
        "src/tools/executor.ts",
        "src/tools/personal-agent-tool-trace.ts",
        "src/platform/drive/drive-system.ts",
        "src/runtime/daemon/runner-goal-cycle.ts",
        "src/runtime/daemon/runner-commands.ts",
        "src/runtime/executor/loop-supervisor.ts",
        "src/interface/mcp-server/tools.ts",
        "tests/contracts/personal-agent-runtime.test.ts"
      ]
    },
    {
      "id": "product-matrix-scenario-classes",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/product-direction/product-boundaries/completion-matrix.md",
        "text": "were audited into current, operator/debug, design-only, boundary, or unsupported"
      },
      "claim": "The product completion matrix and claim ledger are the repo-level docs truth contract.",
      "evidence_refs": [
        "docs/product-direction/product-boundaries/completion-matrix.md",
        "docs/product-direction/product-boundaries/claim-ledger.md",
        "package.json#scripts.check:docs"
      ]
    },
    {
      "id": "product-vision-examples-design-only",
      "classification": "design_only_or_future_direction",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/product-direction/product-framing/vision.md",
        "text": "The examples in this section describe product design direction, not complete workflows"
      },
      "claim": "Vision examples such as multi-year companion operation are design direction, not current workflows.",
      "evidence_refs": [
        "docs/product-direction/product-framing/vision.md",
        "docs/operating/runtime-operations/status.md"
      ]
    },
    {
      "id": "product-vision-advice-boundary",
      "classification": "unsupported_overclaim",
      "claim_kind": "negative_boundary",
      "source": {
        "path": "docs/product-direction/product-framing/vision.md",
        "text": "available in the current package. They are not medical, veterinary, financial,"
      },
      "claim": "Product examples are not advice claims in regulated or high-stakes domains."
    },
    {
      "id": "product-positioning-implemented-foundation",
      "classification": "current_operating_behavior",
      "claim_kind": "current_behavior",
      "source": {
        "path": "docs/product-direction/product-framing/positioning.md",
        "text": "PulSeed's current strongest implementation foundation is long-running goal"
      },
      "claim": "Product positioning names the current implementation foundation without broadening it into complete companion behavior.",
      "evidence_refs": [
        "src/orchestrator/loop/durable-loop.ts",
        "src/runtime/daemon/runner.ts",
        "src/interface/chat/chat-runner.ts"
      ]
    },
    {
      "id": "product-positioning-companion-contract-design",
      "classification": "design_only_or_future_direction",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/product-direction/product-framing/positioning.md",
        "text": "PulSeed's product contract is durable everyday companionship:"
      },
      "claim": "The durable everyday companionship contract is product direction beyond the current operating guide.",
      "evidence_refs": [
        "docs/product-direction/product-framing/positioning.md",
        "docs/operating/runtime-operations/status.md"
      ]
    },
    {
      "id": "design-db-first-migration-boundary",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/runtime-architecture/state-reliability/database-first-state-ownership.md",
        "text": "`doctor --repair` is the compatibility boundary for legacy runtime state."
      },
      "claim": "Legacy runtime files are repair/migration inputs, not normal runtime authority.",
      "evidence_refs": [
        "src/interface/cli/commands/doctor.ts",
        "scripts/check-database-first-legacy-stores.mjs",
        "package.json#scripts.check:database-first-legacy-stores"
      ]
    },
    {
      "id": "design-soil-runtime-store-boundary",
      "classification": "migration_debug_export_config_workspace_boundary",
      "claim_kind": "boundary_or_direction",
      "source": {
        "path": "docs/knowledge-memory/memory-model/soil-system.md",
        "text": "Runtime stores remain authoritative for writes; Soil keeps a typed retrieval"
      },
      "claim": "Soil projections and retrieval do not replace runtime write truth.",
      "evidence_refs": [
        "src/platform/soil/index.ts",
        "docs/operating/runtime-operations/runtime-state.md"
      ]
    }
  ]
}
```
