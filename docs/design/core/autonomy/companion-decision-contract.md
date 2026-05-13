# Companion Decision Contract

> Status: Contract slice for issue #1950. This document describes the shared
> decision frame introduced in `src/runtime/decision/`. It is not a production
> runner rewrite.

## Purpose

PulSeed already has typed pieces for grounding, native AgentLoop execution,
attention, companion state, runtime admission, autonomy, and user-visible action
projection. The missing layer is a single pre-runner decision surface that can
describe the same judgment for chat turns, task execution, and resident
attention cycles without replacing the existing callers.

`CompanionDecisionFrame` is that pre-runner contract. It records what triggered
the decision, what typed evidence and policy refs were available, which existing
caller path should remain responsible for execution, and how the selected
decision can bridge to `CompanionActionProjection` when a normal user-facing
surface needs an expression.

## Ownership Map

| Area | Existing owner | Decision-frame role |
| --- | --- | --- |
| Chat route selection | `src/interface/chat/chat-runner.ts`, `src/interface/chat/ingress-router.ts` | Frame source kind `chat_turn`; caller path remains `chat_gateway_model_loop`, `chat_native_agent_loop`, `chat_runtime_control`, or `chat_configure_route` |
| Task execution | `src/orchestrator/execution/agent-loop/task-agent-loop-runner.ts`, `src/orchestrator/execution/agent-loop/agent-loop-context-assembler.ts` | Frame source kind `task_execution`; task runner remains the execution owner |
| Bounded loop execution | `src/orchestrator/execution/agent-loop/bounded-agent-loop-runner.ts` | Caller path hint only; no loop integration in this slice |
| Grounding | `src/grounding/` | Evidence refs and grounding bundle refs; no duplicated retrieval policy |
| Attention and resident cycles | `src/runtime/attention/` | Frame source kind `resident_attention_cycle`; attention refs remain typed evidence, not direct surface action |
| Companion state | `src/runtime/companion-state-reducer.ts` | Companion state refs and policy refs remain inputs to the decision |
| Admission and autonomy | `src/runtime/control/admission-policy.ts`, `src/runtime/control/autonomy-governor.ts` | Policy refs, admission result, autonomy level, and operator-only raw policy refs |
| User-visible projection | `src/runtime/control/companion-action-projection.ts` | Output uses a projection bridge that delegates to the existing projection contract |

## Contract Shape

The TypeScript contract lives in
`src/runtime/decision/companion-decision-contract.ts`.

The frame is intentionally small:

- `source`: one of `chat_turn`, `task_execution`, or `resident_attention_cycle`
- `input_refs`: typed refs for triggers, targets, state, policy, constraints,
  candidates, and bridge outputs
- `evidence_refs`: refs from grounding, attention, companion state, admission,
  autonomy, runtime control, runners, projection, or feedback
- `policy_refs`: safety, approval, runtime-control, attention, admission,
  autonomy, companion-state, visibility, surface, and character-config policy
  refs
- `active_target_ref`, `active_surface_ref`, `companion_state_ref`,
  `grounding_bundle_ref`, `attention_cycle_ref`, `admission_evaluation_refs`,
  `autonomy_decision_refs`, and `projection_refs`

The output includes:

- `route.disposition`: answer, clarify, hold, prepare, digest, request
  approval, execute, continue durable work, stay silent, refuse with
  alternative, emit a surface intent, or reground before action
- `route.caller_path`: the existing caller path that remains responsible for
  execution
- `route.integration_state`: `contract_only`, `adapter_ready`, or
  `production_wired`
- `trace`: `why_this`, `why_now`, `why_this_route`, evidence refs, policy refs,
  alternatives considered, and suppressed alternatives
- `internal_policy_state`: operator-only policy refs and raw debug refs
- `projection_bridge`: optional bridge to `CompanionActionProjection`

The default integration state for this slice is `contract_only`. That makes the
future adoption path explicit without silently rewiring lower-level runners.

## Boundary Rules

- The frame composes existing contracts. It does not replace Grounding,
  Attention, CompanionState, AdmissionPolicy, AutonomyGovernor, or
  CompanionActionProjection.
- Raw policy state is operator-only. Normal companion surfaces receive the
  existing action projection, whose surface expression policy controls what is
  visible.
- Stale targets are represented as stale or rejected input refs and should route
  to `reground_before_action`, not direct execution.
- Approval-required work must carry `admission_result=approval_required` and a
  route with `requires_approval=true`.
- Quiet work and resident holds use `hold` plus a typed hold reason instead of
  turning attention evidence into immediate speech.
- This contract does not classify freeform user intent with keywords, regexes,
  title matching, or language-specific phrase tables.

## Follow-On Adoption

Future slices can adopt the contract incrementally:

1. Add small adapters that create frames at chat ingress, task execution start,
   and resident attention-cycle start.
2. Persist decision output refs beside existing admission, autonomy, projection,
   or attention audit records.
3. Let #1951 memory projection, #1952 gadget planning, and character-config
   policy add new typed input refs without changing runner ownership.
4. Add caller-path tests only when production paths start consuming the frame.

Until then, the tests for this slice stay contract-level and prove that the same
frame can represent chat, task, resident, stale target, approval-required,
quiet-hold, and user-visible projection cases.
