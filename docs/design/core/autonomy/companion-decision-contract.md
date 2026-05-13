# Companion Decision Contract

> Status: Superseded by the Companion Cognition Layer. This document now
> records the narrow projection bridge left in `src/runtime/decision/`; the
> turn/intervention contract lives in `src/runtime/cognition/`.

## Purpose

PulSeed already has typed pieces for grounding, native AgentLoop execution,
attention, companion state, runtime admission, autonomy, and user-visible action
projection. The current architecture connects those pieces through
`CompanionCognitionInput` and `CompanionCognitionOutput`, which are advisory
turn/intervention artifacts rather than a pre-runner execution owner.

The remaining file at `src/runtime/decision/companion-decision-contract.ts`
contains only projection bridge refs and caller-path vocabulary used by older
contract slices. It must not be expanded into a trace-only cognition layer.

## Ownership Map

| Area | Existing owner | Cognition/projection role |
| --- | --- | --- |
| Chat route selection | `src/interface/chat/chat-runner.ts`, `src/interface/chat/ingress-router.ts` | Cognition caller path is `chat_user_turn`; route execution remains owned by ChatRunner, AgentLoop, gateway model loop, or runtime-control |
| Task execution | `src/orchestrator/execution/agent-loop/task-agent-loop-runner.ts`, `src/orchestrator/execution/agent-loop/agent-loop-context-assembler.ts` | Cognition caller path is `long_running_task_turn`; task runner remains the execution owner |
| Bounded loop execution | `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts` | Caller path hint only; no loop integration in this slice |
| Grounding | `src/grounding/` | Evidence refs and grounding bundle refs; no duplicated retrieval policy |
| Attention and resident cycles | `src/runtime/attention/` | Cognition caller path is `resident_proactive_check`; attention refs remain typed evidence, not direct surface action |
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
- `response_plan`: surface guidance, not final display text
- `tool_candidates` and `authorization_requests`: advisory candidates that must
  pass runtime-control, approval, and tool policy before execution
- `memory_writeback` and `reflection_hints`: pending proposals for later
  admission and consolidation

The projection bridge can still delegate to `CompanionActionProjection` when a
normal user-facing surface needs a filtered expression. It does not own route
selection, tool execution, memory mutation, approval, or notification delivery.

## Boundary Rules

- The cognition output composes existing contracts. It does not replace Grounding,
  Attention, CompanionState, AdmissionPolicy, AutonomyGovernor, or
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
- This contract does not classify freeform user intent with keywords, regexes,
  title matching, or language-specific phrase tables.

## Follow-On Adoption

Future slices can adopt the cognition contract incrementally:

1. Add small adapters that create cognition inputs at chat ingress, task
   execution start, and resident attention-cycle start.
2. Persist decision output refs beside existing admission, autonomy, projection,
   or attention audit records.
3. Let memory projection, gadget planning, and
   `CompanionCharacterPolicyProjection` add typed context refs without changing
   runner ownership.
4. Add caller-path tests only when production paths start consuming the output.
