# Runtime Trace Triage

> Status: Current operator-debug runbook. Use this when a run, trace, or
> projection needs evidence-backed diagnosis.
> Doc status: operator_debug
> Grounding use: operator_truth

Primary references:
[Runtime](../runtime-operations/runtime.md),
[Runtime State](../runtime-operations/runtime-state.md), and
[CLI Reference](../command-reference/cli-commands/cli.md).

```mermaid
flowchart TD
  symptom["User-visible symptom"]
  status["Current status/report"]
  run["Session or run"]
  evidence["Evidence/postmortem"]
  graph["RuntimeGraph explain"]
  replay["Replay or rebuild"]
  fix["Fix docs/code/test"]

  symptom --> status
  status --> run
  run --> evidence
  evidence --> graph
  graph --> replay
  replay --> fix
```

## Triage Order

Start from the user-visible symptom and current status. Only move into raw run,
evidence, RuntimeGraph, event-log, or replay commands when the normal surface
does not explain the issue.

## Operator Rules

- Treat runtime diagnostics as raw operator state.
- Use trace-scoped event-log rebuild as a dry-run unless the change explicitly
  calls for repair.
- Keep source references with any claim that a run was admitted, rejected,
  replayed, deduped, or projected.
- If a diagnostic output conflicts with a current docs claim, update the claim
  ledger or the source doc instead of leaving self-grounding with stale truth.

## Verification Anchors

- `src/interface/cli/commands/runtime.ts`
- `src/runtime/personal-agent/store.ts`
- `src/runtime/store/control-db/schema.ts`
- `tests/contracts/personal-agent-runtime.test.ts`
- `tests/contracts/product-completion-gauntlet.test.ts`
