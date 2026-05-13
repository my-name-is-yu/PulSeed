# Companion Autonomy Implementation Map

> Status: Design document. Verify behavior against source code and current operating docs before treating this as implementation guidance.

This document maps the companion-autonomy contract set into ownership boundaries,
contract placement, and test-harness placement. It is intentionally not a
production implementation. The map should make the contract graph explicit so
related contract work can add schemas, reducers, stores, runtime admission, permission
evaluation, and surface behavior without inventing side-channel policy.

## Source Contracts

The parent contracts are design lanes, not GitHub issue identifiers:

| Contract | Primary source design |
| --- | --- |
| `SurfaceProjection` selection gates | [Relationship Memory And Surface](relationship-memory-surface.md) |
| `CoreCompanionMemoryProjection` decision input | [Core Companion Memory Projection](core-companion-memory-projection.md) |
| deterministic `CompanionState` reducer | [Attention Metabolism And Initiative](attention-metabolism-initiative.md) |
| `GovernedMemory` record-kind ownership | [Relationship Memory And Surface](relationship-memory-surface.md) |
| `SurfaceInvalidationPolicy` and invalidation events | [Relationship Memory And Surface](relationship-memory-surface.md), [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| companion-wide controls and fail-closed resume | [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| `OutcomeDecision` and `ExpressionDecision` | [Attention Metabolism And Initiative](attention-metabolism-initiative.md), [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| `UrgeCandidate`, `AgentAgendaItem`, and initiative gate | [Attention Metabolism And Initiative](attention-metabolism-initiative.md) |
| `RuntimeItem`, authority, staleness, and control policy | [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| `AuditTrace` and `VisibilityPolicy` | [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| `PermissionGrant` lifecycle and evaluator parent | [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| `CompanionDecisionFrame` pre-runner decision surface | [Companion Decision Contract](companion-decision-contract.md) |
| `CompanionGadgetPlan` over verified capability operations | [Companion Gadget Planning](companion-gadget-planning.md), [Companion Capability Runtime](../../infrastructure/runtime/companion-capability-runtime.md) |

The core flow remains:

```text
evidence and traces
  -> GovernedMemory
  -> SurfaceProjection
  -> CoreCompanionMemoryProjection
  -> CompanionStateSnapshot
  -> UrgeCandidate / AgentAgendaItem
  -> InitiativeGateDecision
  -> CompanionDecisionFrame
  -> CompanionGadgetPlan
  -> RuntimeItem admission
  -> CompanionDecisionOutput
  -> OutcomeDecision
  -> ExpressionDecision
  -> AuditTrace / VisibilityPolicy
  -> correction, invalidation, and permission updates
```

No layer may use remembered context, stale Surface, prior target selection, or
natural-language approval text as direct authority for side effects.

## Initial Non-Goals

This map does not:

- implement broad production caller-path behavior
- add TypeScript contract modules
- change runtime-control admission behavior
- change grounding, profile, permission, or tool execution behavior
- add new semantic keyword, regex, `includes`, or title-matching logic
- make design-lane ownership decisions part of runtime policy

Related implementation work should use this map as an ownership guide, not as a
license to implement adjacent contracts opportunistically.

## Cross-Lane Ownership Boundaries

| Boundary | Owning design area | Implementation owner | This map's role |
| --- | --- | --- | --- |
| Governed memory record ownership | memory/profile/Soil/Dream contract | memory/profile/Soil/Dream contract modules | Defines contract-to-module placement only |
| Surface selection and invalidation | Surface projection and invalidation | grounding and Surface contract modules | Records shared dependency rules |
| Companion state reducer | companion state | attention/state reducer modules | Records reducer inputs and caller-path harness placement |
| Urge and agenda pipeline | attention metabolism | attention pipeline modules | Keeps signal, urge, agenda, inhibition, and gate separate |
| Runtime item authority and staleness | runtime control | runtime-control modules | Keeps status, posture, authority, staleness, and control policy separate |
| Companion-wide controls and resume | runtime control | runtime-control modules | Marks fail-closed controls and stale resume tests as required |
| Outcome and expression decisions | attention/runtime decisions | runtime/grounding decision modules | Prevents surfaces from recreating permission or visibility policy |
| Audit and visibility | runtime visibility/audit | runtime visibility/audit modules | Marks redaction and inspectability as shared policy |
| Permission grants | runtime permission | runtime permission modules | Keeps grants explicit, scoped, stale-aware, and revocable |
| Completed permission persistence and policy integration | runtime permission dependencies | runtime permission modules | Treat as dependency context; do not duplicate in permission work |
| Waiting permission resume | runtime permission dependencies | runtime permission modules | Keep stored-plan resume tests as dependency context |
| Multi-surface rendering | surface integration | surface integration modules | Surfaces render shared decisions; they do not own policy |

If a module needs a field owned by another boundary, the design should name that
dependency explicitly instead of duplicating ownership.

## Module Ownership

The paths below are target placement, not edits in this map.

| Target contract or slice | Owned module area | Test harness placement |
| --- | --- | --- |
| Surface selection gates | `src/grounding/`, future Surface contract modules, grounding providers | Surface selector contract tests plus chat/TUI/gateway caller-path coverage after production path exists |
| CompanionState reducer | attention/state reducer modules, runtime-control input adapters | deterministic reducer tests and at least one runtime caller-path reducer-input test |
| GovernedMemory ownership | `src/platform/profile/`, `src/platform/soil/`, future governed-memory contracts | schema validation tests plus owner-boundary tests for profile, runtime evidence, Soil, and Dream proposals |
| Surface invalidation | Surface invalidation store/events, runtime dependency refs | invalidation event contract tests and end-to-end dependent-decision invalidation tests |
| companion-wide controls | `src/runtime/control/`, runtime operation/session stores, chat ingress | two-turn control tests for quiet, pause, suspend, resume, and stale control rejection |
| OutcomeDecision and ExpressionDecision | runtime admission boundary, grounding/surface decision projections | runtime admission tests and multi-surface rendering contract tests that do not duplicate policy |
| urge and agenda pipeline | attention pipeline modules, schedule/drive/curiosity input adapters | signal-to-urge-to-gate tests plus production caller-path routing coverage |
| RuntimeItem authority and staleness | `src/runtime/control/`, `src/runtime/store/`, session registry, daemon/schedule stores | authority, staleness, control-policy, and adapter consumption tests |
| audit and visibility policy | runtime audit/visibility modules, inspection/snapshot projections | redaction, tombstone, quiet-work, and inspection visibility tests |
| MemoryRole and RecordKind enums | governed-memory contract module | enum/schema tests with invalid role and record-kind rejection |
| record-kind domain fields | governed-memory contract module | per-kind domain field validation tests |
| GovernedMemory base schema | governed-memory contract module | base schema and owner invariant tests |
| epistemic status and confidence | governed-memory contract module | confidence/source reliability validation tests |
| allowed and forbidden runtime use | governed-memory contract module, Surface selector | allowed-use and forbidden-use admission tests |
| lifecycle states | governed-memory contract module, Surface selector | retired, suppressed, tombstone, and deletion exclusion tests |
| correction and supersession events | memory lifecycle/invalidation module | correction, supersession, retraction, and invalidation tests |
| seed candidate handling | Dream/proposal ownership boundary | seed candidate non-Surface tests until accepted |
| memory audit | memory audit and Surface rationale modules | consideration, inclusion, exclusion, and non-use audit tests |
| SurfaceProjection schema | Surface contract module | schema/source-ref validation tests |
| ordered projection gates | Surface selector | scope, lifecycle, staleness, sensitivity, permission, use, projection, audit gate-order tests |
| Surface lanes | Surface contract module | lane validation including Exclusion lane tests |
| projection rationale | Surface selector/audit refs | rationale and blocked-context redaction tests |
| relationship permissions in projection | profile-to-Surface adapter | permission projection tests without raw profile permission bypass |
| stale sensitive superseded rejection | Surface selector | stale/sensitive/superseded projection rejection tests |
| Surface inspection | inspection/snapshot projection | inspection tests that avoid prompt-dumping memory |
| SurfaceInvalidationPolicy | Surface invalidation contract module | policy and event validation tests |
| dependency refs | runtime dependency ref module | dependency tracking tests for runtime objects |
| agenda and urge invalidation | attention invalidation integration | invalidated Surface holds/decays/expires urge and agenda tests |
| OutcomeDecision invalidation | runtime decision store | expire or re-admit dependent outcome tests |
| ExpressionDecision invalidation | expression decision store | hold or withdraw dependent expression tests |
| memory-write revalidation | memory write candidate path | candidate revalidation tests after Surface invalidation |
| deletion and tombstone non-reconstruction | Surface/audit/debug/inspection paths | deleted content non-reconstruction tests |
| end-to-end invalidation tests | production caller paths | full caller-path invalidation harness |
| companion-state contracts | companion-state contract module | snapshot and reducer input schema tests |
| reducer input assembly | runtime-to-state adapter | real runtime item/event input assembly tests |
| global-control precedence | companion-state reducer | precedence and overlay tests |
| safety authority and stale Surface blockers | companion-state reducer and runtime authority input | blocker tests for revoked permission and stale Surface |
| budgets thresholds cooldowns blockers | companion-state reducer | deterministic budget/threshold/cooldown tests |
| pre-suspend posture | companion-state reducer and runtime controls | suspend/resume tests that prevent active work leakage |
| derivation traces | companion-state reducer audit trace | trace and rejected-mode persistence tests |
| high-watermark idempotency | companion-state reducer | same-input/high-watermark idempotency tests |
| recomputation triggers | runtime/Surface feedback integration | Surface feedback and wait-change recomputation tests |
| SignalContext assembly | attention input module | signal input assembly tests |
| UrgeCandidate schema | attention contract module | urge schema and vocabulary tests |
| AgentAgendaItem schema | attention contract module | agenda item kind validation tests |
| urge merge and dedupe | attention agenda builder | merge/dedupe tests preserving provenance |
| maturation and decay | attention state machine | maturation, decay, and hold tests |
| InhibitionDecision | attention inhibition module | block, delay, narrow, and admit tests |
| InitiativeGateDecision | attention initiative gate | outcome selection tests using shared outcome vocabulary |
| Drive and curiosity separation | drive/curiosity adapters into attention | tests proving candidates do not directly become expression |
| scheduler wake re-evaluation | schedule-to-attention adapter | scheduler wake tests that re-evaluate rather than notify |
| feedback to future initiative | feedback-to-attention adapter | conservative feedback application tests |
| RuntimeItem schema | runtime contract module | item type and schema tests |
| status and posture separation | runtime contract/control module | status/posture separation tests |
| Authority schema | runtime authority module | fail-closed authority derivation tests |
| Staleness schema | runtime staleness module | temporal, world, project, permission, relationship, Surface, goal, assumption, and session staleness tests |
| ControlPolicy | runtime control-policy module | per-item control policy tests |
| RuntimeEvent facts | runtime event module | typed transition event tests |
| production control boundaries | runtime-control service and adapters | caller-path tests for shared runtime contract consumption |
| auth handoffs and browser sessions as RuntimeItems | automation/runtime bridge | auth, browser session, guardrail, and backpressure item tests |
| global control state | runtime control store | persistence and epoch tests |
| quiet mode and proactivity pause | runtime control service | admission effects and no-backlog-flush tests |
| suspend and resume companion | runtime control service | fail-closed suspend/resume tests |
| stop quiet work, watches, agenda | runtime control service and stores | bounded cancellation and suppression tests |
| backlog flush prevention | runtime control service | lift-control re-gating tests |
| typed control vocabulary | runtime control contracts | control vocabulary and item-class scope tests |
| resume decisions and re-grounding | session registry/runtime resume | resume outcome and re-grounding tests |
| inspect vs resume authority | session inspection/resume boundary | old-session inspectable-but-not-resumable tests |
| OutcomeClass vocabulary | attention/runtime shared contract | vocabulary consistency tests |
| OutcomeDecision persistence | runtime decision store | post-admission persistence tests |
| downgrade and rejection encoding | runtime admission | no fake final outcome tests |
| ExpressionDecision creation | expression policy module | surface-facing-only expression tests |
| digest routing | expression policy and digest projection | digest through ExpressionDecision tests |
| shared surface rendering | chat/TUI/CLI/daemon/gateway/future GUI adapters | adapter rendering tests without local policy |
| visibility to decisions | visibility policy and decision projection | visibility-connected outcome/expression tests |
| AuditTrace schema | runtime audit module | action, withheld, stale, permission, and repair-option audit tests |
| silence and quiet-work audit | runtime audit module | withheld work and quiet-work audit tests |
| repair options | runtime audit/control integration | stop, narrow, revoke, forget, and re-ground repair tests |
| deletion/tombstone redaction | audit/debug/inspection paths | redaction tests across inspection paths |
| VisibilityPolicy schema | runtime visibility module | default visibility validation tests |
| hidden internal runtime state | inspection/snapshot projection | inspectable-but-hidden tests |
| redacted companion-state inspection | companion-state inspection projection | redacted inspection tests |
| multi-surface semantics | chat/TUI/CLI/daemon/gateway/future GUI adapters | shared semantics tests across surfaces |
| gadget candidate and plan contract | `src/runtime/decision/companion-gadget-planning.ts`, capability operation plan substrate, admission, autonomy, action projection | schema tests plus gateway chat, AgentLoop/task, and resident/runtime-control caller-path evals |
| remaining PermissionGrant parent work | runtime permission contract/evaluator | lifecycle, stale, revoke, reuse, exclusion, and caller-path tests not already covered by completed slices |
| conversational grant decisions | chat permission classifier into grant evaluator | typed decision tests with ambiguous and multilingual paraphrases |
| waiting_for_permission stored plans | runtime permission wait/resume state | keep stored-plan resume tests as dependency context |
| grant visibility and revoke controls | runtime permission visibility/control surfaces | active grant, reuse reason, and revoke inspection tests |

Completed permission dependency context should be treated as implementation
history. Later permission work should focus on grant UX, visibility, revoke,
conversational classification, and parent acceptance not already covered by
closed slices.

## Test Harness Contract

Contract tests should live beside the owning modules once those modules exist.
Existing PulSeed patterns place runtime-control tests under
`src/runtime/control/__tests__/`, gateway and ingress tests under
`src/runtime/gateway/__tests__/`, chat caller-path tests under
`src/interface/chat/__tests__/`, and automation/runtime bridge tests under
`src/tools/automation/__tests__/`.

Implementations should add tests in this order:

1. schema or reducer contract tests beside the owning contract module
2. store or state-machine tests beside the owning runtime/memory module
3. adapter tests only after the shared contract exists
4. at least one production caller-path test for any behavior that claims shared
   routing, permission, stale-target rejection, resume, or multi-surface parity

Mock-only tests are insufficient for the parent contracts when the behavior
crosses grounding, runtime control, chat ingress, session registry, or surface
rendering. Keep narrow mock tests for local behavior, then add a caller-path
contract test that lets production routing or interpretation select the path.

## Contract Dependency Order

The contracts should be introduced in dependency order:

1. Foundation schemas: governed memory, Surface, runtime
   item, then remaining permission work.
2. State and attention contracts after their inputs exist.
3. Invalidation and control behavior.
4. Decisions, visibility, and audit.
5. Dependent contract groups, keeping caller-path tests with the first
   production integration in each group.
6. Multi-surface parity after shared decisions, visibility, audit, and
   permission contracts are consumed by at least one production path.

This order avoids surfaces or adapters becoming the policy owner before the
shared contracts exist.

## Review Checklist

- Does any change classify freeform intent, approval, routing, safety,
  permission, control, or target selection with keyword, regex, `includes`, or
  title matching?
- Does any behavior reuse a stale Surface, stale session, stale grant, prior
  target, or previous run plan without explicit compatibility evidence?
- Can deleted or tombstoned content leak through Surface snapshots, audit,
  debug, inspection, runtime events, decisions, or derived rationale?
- Do surfaces render shared decisions instead of recreating permission,
  staleness, visibility, or outcome policy locally?
- Are denied approvals, expired grants, and failed authority checks represented
  as non-execution state rather than summarized as completed work?
- Does every parent contract with runtime behavior have at least one
  production caller-path test once production behavior is added?
- Is quiet work inspectable and interruptible without becoming user-facing
  noise by default?
- Are memory, relationship context, and permission grants kept as separate
  contracts?
