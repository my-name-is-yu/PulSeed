# Companion Decision Contract

> Status: Superseded by the Companion Cognition Layer. This document now
> records the narrow projection bridge left in `src/runtime/decision/`; the
> turn/intervention contract lives in `src/runtime/cognition/`.
> Doc status: historical_context
> Grounding use: archive_only

Primary map: [Cognition And Decision](./cognition-decision-map.md).

## Purpose

PulSeed already has typed pieces for grounding, native AgentLoop execution,
attention and commitment selection, companion state, runtime admission,
autonomy, Memory Truth Maintenance, RuntimeGraph/Event Log, and user-visible
action projection. The current architecture connects those pieces through
`CompanionCognitionKernel`, `CompanionCognitionInput`, and
`CompanionCognitionOutput`, which are advisory artifacts rather than a
pre-runner execution owner.

The remaining file at `src/runtime/decision/companion-decision-contract.ts`
contains only projection bridge refs and caller-path vocabulary used by older
contracts. It must not be expanded into a trace-only cognition layer.

## Ownership Map

| Area | Existing owner | Cognition/projection role |
| --- | --- | --- |
| Chat route selection | `src/interface/chat/chat-runner.ts`, `src/interface/chat/ingress-router.ts` | Cognition caller path is `chat_user_turn`; route execution remains owned by ChatRunner, AgentLoop, gateway model loop, or runtime-control |
| Task execution | `src/orchestrator/execution/agent-loop/task-agent-loop-runner.ts`, `src/orchestrator/execution/agent-loop/agent-loop-context-assembler.ts` | Cognition caller path is `long_running_task_turn`; task runner remains the execution owner |
| Bounded loop execution | `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts` | Caller path hint only; loop integration remains owned by production runner paths |
| Grounding | `src/grounding/` | Evidence refs and grounding bundle refs; no duplicated retrieval policy |
| Attention and resident cycles | `src/runtime/attention/`, `src/runtime/store/attention-state-store.ts` | Cognition caller path is `resident_proactive_check`; attention and commitment refs remain typed evidence, not direct surface action, and the kernel must not duplicate #2000 commitment classifiers, stores, or operation selection |
| Schedule wakes | `src/runtime/schedule/personal-agent-trace.ts`, `src/runtime/schedule/engine-layers.ts` | Cognition caller path is `schedule_wake`; ScheduleEngine remains the cadence/retry owner |
| Runtime-control responses | `src/runtime/control/runtime-control-service.ts` | Cognition caller path is `runtime_control_response`; runtime-control, approval, permission, and operation stores remain mutation owners |
| Memory truth operations | `src/platform/corrections/user-memory-operations.ts`, `src/runtime/store/memory-truth-maintenance-store.ts` | Cognition caller path is `memory_truth_operation`; Memory Truth Maintenance remains the truth owner and cognition only records future behavioral inhibition/audit refs |
| Companion state | `src/runtime/companion-state-reducer.ts` | Companion state refs and policy refs remain inputs to the decision |
| Admission and autonomy | `src/runtime/control/admission-policy.ts`, `src/runtime/control/autonomy-governor.ts` | Policy refs, admission result, autonomy level, and operator-only raw policy refs |
| User-visible projection | `src/runtime/control/companion-action-projection.ts` | Output uses a projection bridge that delegates to the existing projection contract |

## Contract Shape

The TypeScript cognition contract lives in `src/runtime/cognition/contracts.ts`.
The output is intentionally advisory:

- `situation_model`: current caller path, active targets, stale targets, and
  source event refs
- `relationship_state`: included and withheld governed memory refs
- `selected_intention`: selected or regrounding-only intention proposal
- `candidate_action`: no-op, hold, suppress, continue, digest, suggest,
  prepare, authority request, or handoff candidate that never executes side
  effects
- `commitment_handoff`: #2000 attention/commitment state handoff using
  `AttentionStateStore`, without a parallel commitment lifecycle
- `response_plan`: surface guidance, not final display text
- `memory_use_audit`: included/withheld memory refs plus the
  Memory Truth Maintenance owner boundary
- `authority_handoff`: proposed authority boundary for Interaction Authority,
  runtime-control, or tool policy, without approval bypass
- `tool_candidates` and `authorization_requests`: advisory candidates that must
  pass runtime-control, approval, and tool policy before execution
- `memory_writeback` and `reflection_hints`: pending proposals for later
  admission and consolidation
- `correlation_refs`: replay and idempotency refs for deterministic audit and
  restart/replay checks

The projection bridge can still delegate to `CompanionActionProjection` when a
normal user-facing surface needs a filtered expression. It does not own route
selection, tool execution, memory mutation, approval, or notification delivery.

## Boundary Rules

- The cognition output composes existing contracts. It does not replace
  Grounding, Attention/Commitment, CompanionState, AdmissionPolicy,
  AutonomyGovernor, RuntimeGraph/Event Log, Memory Truth Maintenance, or
  CompanionActionProjection.
- Raw policy state is operator-only. Normal companion surfaces receive the
  existing action projection, whose surface expression policy controls what is
  visible.
- Stale targets are represented as stale or rejected refs and should produce a
  regrounding intention, not direct execution.
- Approval-required work must carry `admission_result=approval_required` and a
  route with `requires_approval=true`.
- Quiet work and resident holds use `hold` plus a typed hold reason instead of
  turning attention evidence into immediate speech.
- Direct production callers must not assemble freeform behavioral prompt policy,
  memory-use policy, commitment policy, action policy, quieting, suppression, or
  stale-target decisions outside the kernel and owning typed stores.
- This contract does not classify freeform user intent with keywords, regexes,
  title matching, string `includes`, or language-specific phrase tables.

## Follow-On Adoption

Future integrations can adopt the cognition contract by adding typed input
assemblers at the production boundary, feeding the kernel output into the
existing owner for that concern, and adding caller-path tests that cross the
production boundary. New direct prompt/policy assembly should be treated as a
regression unless it is a provider adapter, diagnostic/operator surface,
migration path, eval fixture, or test-only helper.
