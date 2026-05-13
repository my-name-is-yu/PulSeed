# Companion Gadget Planning

> Status: Implemented contract slice. Runtime truth remains the TypeScript
> contracts and production caller paths listed below.

Companion gadget planning is the control-plane layer that turns a grounded
companion situation into a bounded candidate capability and a safe next action.
It does not execute tools and it does not replace the capability runtime,
admission policy, autonomy governor, approval flow, or AgentLoop executor.

## Canonical Source Paths

The planning contract composes these current implementation paths:

| Concern | Canonical path |
| --- | --- |
| capability graph and readiness substrate | `src/platform/observation/types/capability.ts` |
| operation plan candidate substrate | `src/runtime/types/capability-operation-plan.ts` |
| resident and schedule operation-plan assembly | `src/runtime/capability-operation-planner.ts` |
| exact-scope admission policy | `src/runtime/control/admission-policy.ts` |
| readiness, policy, approval, feedback, and autonomy decision | `src/runtime/control/autonomy-governor.ts` |
| normal companion action projection | `src/runtime/control/companion-action-projection.ts` |
| gadget candidate, plan, and action candidate contract | `src/runtime/decision/companion-gadget-planning.ts` |
| cognition context refs | `src/runtime/decision/companion-decision-contract.ts`, `src/runtime/cognition/contracts.ts` |
| governed memory projection input | `src/runtime/decision/core-companion-memory-projection.ts` |
| AgentLoop execution substrate | `src/orchestrator/execution/agent-loop/` |
| approval and runtime-control substrate | `src/runtime/control/`, `src/runtime/store/` |

## Vocabulary

| Term | Meaning in this contract |
| --- | --- |
| capability | Durable operation substrate identity with readiness and policy evidence. |
| tool | Runtime callable route behind a capability operation. |
| skill | Packaged human or model-facing capability description that may need a runtime capability before use. |
| plugin | Installed extension provider that may expose tools, skills, surfaces, or integrations. |
| integration | External or local service binding with auth, config, and permission state. |
| surface | User-facing or operator-facing place where a plan can be shown, approved, or withheld. |
| gadget candidate | A situation-matched asset plus operation plan and readiness summary. It can say the substrate `can_execute`, but it never grants initiation authority. |
| gadget plan | Candidate plus admission, autonomy, action projection, user-facing policy projection, audit refs, and feedback policy. |
| action candidate | The safe next action the companion may suggest, prepare, ask approval for, execute, refuse, or hold. |

## Planning Flow

```text
CompanionCognitionOutput and CoreCompanionMemoryProjection
  -> candidate capability or tool retrieval
  -> CapabilityOperationPlanCandidate
  -> CapabilityReadinessSnapshot filtering
  -> AdmissionPolicyEvaluation
  -> AutonomyDecision
  -> CompanionActionProjection
  -> CompanionGadgetPlan
  -> approval, preparation, execution, refusal, quiet hold, or outcome feedback
```

The final `CompanionGadgetPlan` is deliberately not an executor. Execution still
requires the downstream AgentLoop or runtime executor to consume an admitted
operation through its canonical approval and audit path.

## Invariants

- `can_execute` means the operation has matching `executable_verified`
  readiness and no stale readiness evidence.
- `may_initiate` additionally requires exact-scope admission `allowed`,
  autonomy level `user_directed_execute` or `autonomous_low_risk`, no pending
  user approval, and an action projection that executes the operation.
- A gadget candidate always has `may_initiate=false`; model text can only be
  trace evidence and never authority.
- Normal companion surfaces may advertise execution only when the action
  candidate also `may_initiate`.
- Unverified, unauthenticated, degraded, blocked, stale, suppressed, prohibited,
  or approval-required paths fail closed into prepare, approval, refusal, or
  hold behavior.
- `CompanionActionProjection` remains the canonical ordinary-surface filter:
  raw readiness, admission, autonomy, policy refs, and capability catalogs stay
  hidden from normal companion UX.
- Outcome feedback is conservative by default. Rejection or overreach becomes
  an autonomy feedback signal that narrows future planning through
  `require_confirmation`, `narrow_scope`, `reduce_frequency`, or
  `avoid_sensitive_context`.

## Composition With Memory And Decision Contracts

`CompanionCognitionOutput` owns the turn/intervention situation and caller-path refs.
`CoreCompanionMemoryProjection` supplies governed memory inputs with explicit
use policy. Gadget planning may cite both as source refs, but neither memory nor
model text becomes runtime authority. Stale or corrected memory should already
be withheld by the memory projection before a gadget candidate is assembled.

## Test Contract

Current contract tests live in
`src/runtime/decision/__tests__/companion-gadget-planning.test.ts`.
They assert:

- executable readiness does not imply initiation when admission or autonomy
  still requires approval
- initiation is allowed only when readiness, admission, autonomy, and action
  projection all agree
- authenticated but unverified capabilities are not advertised or selected as
  executable by model text alone
- normal companion surfaces cannot advertise execution for non-initiable actions
- mismatched operation/admission/autonomy/projection scopes are rejected rather
  than reinterpreted

Follow-on caller-path evals should use this contract from gateway chat,
AgentLoop or task runtime, and resident attention/runtime-control paths so the
real routing layer chooses the gadget path rather than tests passing precomputed
lower-level decisions only.
