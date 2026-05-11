# Companion Autonomy Implementation Map

> Status: Internal design note. Verify public behavior against source code and public-current docs before treating this as user-facing guidance.

Status: Wave 0 implementation map for #1272 through #1280 and the remaining
open #1356 permission-grant work.

This document maps the companion-autonomy issue tree into ownership boundaries,
contract placement, and test-harness placement. It is intentionally not a
production implementation. Wave 0 should make the contract graph explicit so
later lanes can add schemas, reducers, stores, runtime admission, permission
evaluation, and surface behavior without inventing side-channel policy.

## Source Contracts

The live parent contract issues are all open as of this map:

| Issue | Contract | Primary source design |
| --- | --- | --- |
| #1272 | `SurfaceProjection` selection gates | [Relationship Memory And Surface](relationship-memory-surface.md) |
| #1273 | deterministic `CompanionState` reducer | [Attention Metabolism And Initiative](attention-metabolism-initiative.md) |
| #1274 | `GovernedMemory` record-kind ownership | [Relationship Memory And Surface](relationship-memory-surface.md) |
| #1275 | `SurfaceInvalidationPolicy` and invalidation events | [Relationship Memory And Surface](relationship-memory-surface.md), [Runtime Control Plane](../infrastructure/runtime-control-plane.md) |
| #1276 | companion-wide controls and fail-closed resume | [Runtime Control Plane](../infrastructure/runtime-control-plane.md) |
| #1277 | `OutcomeDecision` and `ExpressionDecision` | [Attention Metabolism And Initiative](attention-metabolism-initiative.md), [Runtime Control Plane](../infrastructure/runtime-control-plane.md) |
| #1278 | `UrgeCandidate`, `AgentAgendaItem`, and initiative gate | [Attention Metabolism And Initiative](attention-metabolism-initiative.md) |
| #1279 | `RuntimeItem`, authority, staleness, and control policy | [Runtime Control Plane](../infrastructure/runtime-control-plane.md) |
| #1280 | `AuditTrace` and `VisibilityPolicy` | [Runtime Control Plane](../infrastructure/runtime-control-plane.md) |
| #1356 | `PermissionGrant` lifecycle and evaluator parent; #1360, #1361, and #1362 are closed dependency context | [Runtime Control Plane](../infrastructure/runtime-control-plane.md) |

The core flow remains:

```text
evidence and traces
  -> GovernedMemory
  -> SurfaceProjection
  -> CompanionStateSnapshot
  -> UrgeCandidate / AgentAgendaItem
  -> InitiativeGateDecision
  -> RuntimeItem admission
  -> OutcomeDecision
  -> ExpressionDecision
  -> AuditTrace / VisibilityPolicy
  -> correction, invalidation, and permission updates
```

No layer may use remembered context, stale Surface, prior target selection, or
natural-language approval text as direct authority for side effects.

## First-Phase Non-Goals

Wave 0 does not:

- implement broad production caller-path behavior
- add TypeScript contract modules
- change runtime-control admission behavior
- change grounding, profile, permission, or tool execution behavior
- add new semantic keyword, regex, `includes`, or title-matching logic
- close any parent issue
- move issue ownership between lanes after PR handoff

Later implementation lanes should use this map as an ownership guide, not as a
license to implement adjacent contracts opportunistically.

## Cross-Lane Ownership Boundaries

| Boundary | Owning contract | Later implementation owner | This map's role |
| --- | --- | --- | --- |
| Governed memory record ownership | #1274 | memory/profile/Soil/Dream contract lane | Defines issue-to-module placement only |
| Surface selection and invalidation | #1272, #1275 | grounding and Surface contract lane | Records shared dependency rules |
| Companion state reducer | #1273 | attention/state reducer lane | Records reducer inputs and caller-path harness placement |
| Urge and agenda pipeline | #1278 | attention pipeline lane | Keeps signal, urge, agenda, inhibition, and gate separate |
| Runtime item authority and staleness | #1279 | runtime-control lane | Keeps status, posture, authority, staleness, and control policy separate |
| Companion-wide controls and resume | #1276 | runtime-control lane | Marks fail-closed controls and stale resume tests as required |
| Outcome and expression decisions | #1277 | runtime/grounding decision lane | Prevents surfaces from recreating permission or visibility policy |
| Audit and visibility | #1280 | runtime visibility/audit lane | Marks redaction and inspectability as shared policy |
| Permission grants | #1356 | runtime permission lane | Keeps grants explicit, scoped, stale-aware, and revocable |
| Completed permission persistence and policy integration | #1360, #1361, #1362 | runtime permission lane | Treat as dependency context; do not duplicate in later #1356 work |
| Waiting permission resume | #1358 | runtime permission lane | Closed before this map; keep as dependency context only |
| Multi-surface rendering | #1355 | future surface integration lane | Surfaces render shared decisions; they do not own policy |

If a later lane needs a field owned by another boundary, it should add an
integration note to its PR body unless its target issue explicitly owns that
contract.

## Issue-To-Module Ownership

The paths below are target placement, not Wave 0 edits.

| Issue | Target contract or slice | Owned module area | Test harness placement |
| --- | --- | --- | --- |
| #1272 | Surface selection gates | `src/grounding/`, future Surface contract modules, grounding providers | Surface selector contract tests plus chat/TUI/gateway caller-path coverage after production path exists |
| #1273 | CompanionState reducer | future attention/state reducer modules, runtime-control input adapters | deterministic reducer tests and at least one runtime caller-path reducer-input test |
| #1274 | GovernedMemory ownership | `src/platform/profile/`, `src/platform/soil/`, future governed-memory contracts | schema validation tests plus owner-boundary tests for profile, runtime evidence, Soil, and Dream proposals |
| #1275 | Surface invalidation | future Surface invalidation store/events, runtime dependency refs | invalidation event contract tests and end-to-end dependent-decision invalidation tests |
| #1276 | companion-wide controls | `src/runtime/control/`, runtime operation/session stores, chat ingress | two-turn control tests for quiet, pause, suspend, resume, and stale control rejection |
| #1277 | OutcomeDecision and ExpressionDecision | runtime admission boundary, grounding/surface decision projections | runtime admission tests and multi-surface rendering contract tests that do not duplicate policy |
| #1278 | urge and agenda pipeline | future attention pipeline modules, schedule/drive/curiosity input adapters | signal-to-urge-to-gate tests plus production caller-path routing coverage |
| #1279 | RuntimeItem authority and staleness | `src/runtime/control/`, `src/runtime/store/`, session registry, daemon/schedule stores | authority, staleness, control-policy, and adapter consumption tests |
| #1280 | audit and visibility policy | runtime audit/visibility modules, inspection/snapshot projections | redaction, tombstone, quiet-work, and inspection visibility tests |
| #1281 | MemoryRole and RecordKind enums | governed-memory contract module | enum/schema tests with invalid role and record-kind rejection |
| #1282 | record-kind domain fields | governed-memory contract module | per-kind domain field validation tests |
| #1283 | GovernedMemory base schema | governed-memory contract module | base schema and owner invariant tests |
| #1284 | epistemic status and confidence | governed-memory contract module | confidence/source reliability validation tests |
| #1285 | allowed and forbidden runtime use | governed-memory contract module, Surface selector | allowed-use and forbidden-use admission tests |
| #1286 | lifecycle states | governed-memory contract module, Surface selector | retired, suppressed, tombstone, and deletion exclusion tests |
| #1287 | correction and supersession events | memory lifecycle/invalidation module | correction, supersession, retraction, and invalidation tests |
| #1288 | seed candidate handling | Dream/proposal ownership boundary | seed candidate non-Surface tests until accepted |
| #1289 | memory audit | memory audit and Surface rationale modules | consideration, inclusion, exclusion, and non-use audit tests |
| #1290 | SurfaceProjection schema | Surface contract module | schema/source-ref validation tests |
| #1291 | ordered projection gates | Surface selector | scope, lifecycle, staleness, sensitivity, permission, use, projection, audit gate-order tests |
| #1292 | Surface lanes | Surface contract module | lane validation including Exclusion lane tests |
| #1293 | projection rationale | Surface selector/audit refs | rationale and blocked-context redaction tests |
| #1294 | relationship permissions in projection | profile-to-Surface adapter | permission projection tests without raw profile permission bypass |
| #1295 | stale sensitive superseded rejection | Surface selector | stale/sensitive/superseded projection rejection tests |
| #1296 | Surface inspection | inspection/snapshot projection | inspection tests that avoid prompt-dumping memory |
| #1297 | SurfaceInvalidationPolicy | Surface invalidation contract module | policy and event validation tests |
| #1298 | dependency refs | runtime dependency ref module | dependency tracking tests for runtime objects |
| #1299 | agenda and urge invalidation | attention invalidation integration | invalidated Surface holds/decays/expires urge and agenda tests |
| #1300 | OutcomeDecision invalidation | runtime decision store | expire or re-admit dependent outcome tests |
| #1301 | ExpressionDecision invalidation | expression decision store | hold or withdraw dependent expression tests |
| #1302 | memory-write revalidation | memory write candidate path | candidate revalidation tests after Surface invalidation |
| #1303 | deletion and tombstone non-reconstruction | Surface/audit/debug/inspection paths | deleted content non-reconstruction tests |
| #1304 | end-to-end invalidation tests | production caller paths | full caller-path invalidation harness |
| #1305 | CompanionStateSnapshot contracts | companion-state contract module | snapshot and reducer input schema tests |
| #1306 | reducer input assembly | runtime-to-state adapter | real runtime item/event input assembly tests |
| #1307 | global-control precedence | companion-state reducer | precedence and overlay tests |
| #1308 | safety authority and stale Surface blockers | companion-state reducer and runtime authority input | blocker tests for revoked permission and stale Surface |
| #1309 | budgets thresholds cooldowns blockers | companion-state reducer | deterministic budget/threshold/cooldown tests |
| #1310 | pre-suspend posture | companion-state reducer and runtime controls | suspend/resume tests that prevent active work leakage |
| #1311 | derivation traces | companion-state reducer audit trace | trace and rejected-mode persistence tests |
| #1312 | high-watermark idempotency | companion-state reducer | same-input/high-watermark idempotency tests |
| #1313 | recomputation triggers | runtime/Surface feedback integration | Surface feedback and wait-change recomputation tests |
| #1314 | SignalContext assembly | attention input module | signal input assembly tests |
| #1315 | UrgeCandidate schema | attention contract module | urge schema and vocabulary tests |
| #1316 | AgentAgendaItem schema | attention contract module | agenda item kind validation tests |
| #1317 | urge merge and dedupe | attention agenda builder | merge/dedupe tests preserving provenance |
| #1318 | maturation and decay | attention state machine | maturation, decay, and hold tests |
| #1319 | InhibitionDecision | attention inhibition module | block, delay, narrow, and admit tests |
| #1320 | InitiativeGateDecision | attention initiative gate | outcome selection tests using shared outcome vocabulary |
| #1321 | Drive and curiosity separation | drive/curiosity adapters into attention | tests proving candidates do not directly become expression |
| #1322 | scheduler wake re-evaluation | schedule-to-attention adapter | scheduler wake tests that re-evaluate rather than notify |
| #1323 | feedback to future initiative | feedback-to-attention adapter | conservative feedback application tests |
| #1324 | RuntimeItem schema | runtime contract module | item type and schema tests |
| #1325 | status and posture separation | runtime contract/control module | status/posture separation tests |
| #1326 | no companion-autonomy issue; number is a merged PR in current GitHub state | none | none |
| #1327 | Authority schema | runtime authority module | fail-closed authority derivation tests |
| #1328 | Staleness schema | runtime staleness module | temporal, world, project, permission, relationship, Surface, goal, assumption, and session staleness tests |
| #1329 | ControlPolicy | runtime control-policy module | per-item control policy tests |
| #1330 | RuntimeEvent facts | runtime event module | typed transition event tests |
| #1331 | production control boundaries | runtime-control service and adapters | caller-path tests for shared runtime contract consumption |
| #1332 | auth handoffs and browser sessions as RuntimeItems | automation/runtime bridge | auth, browser session, guardrail, and backpressure item tests |
| #1333 | global control state | runtime control store | persistence and epoch tests |
| #1334 | quiet mode and proactivity pause | runtime control service | admission effects and no-backlog-flush tests |
| #1335 | suspend and resume companion | runtime control service | fail-closed suspend/resume tests |
| #1336 | stop quiet work, watches, agenda | runtime control service and stores | bounded cancellation and suppression tests |
| #1337 | backlog flush prevention | runtime control service | lift-control re-gating tests |
| #1338 | typed control vocabulary | runtime control contracts | control vocabulary and item-class scope tests |
| #1339 | resume decisions and re-grounding | session registry/runtime resume | resume outcome and re-grounding tests |
| #1340 | inspect vs resume authority | session inspection/resume boundary | old-session inspectable-but-not-resumable tests |
| #1341 | OutcomeClass vocabulary | attention/runtime shared contract | vocabulary consistency tests |
| #1342 | OutcomeDecision persistence | runtime decision store | post-admission persistence tests |
| #1343 | downgrade and rejection encoding | runtime admission | no fake final outcome tests |
| #1344 | ExpressionDecision creation | expression policy module | surface-facing-only expression tests |
| #1345 | digest routing | expression policy and digest projection | digest through ExpressionDecision tests |
| #1346 | shared surface rendering | chat/TUI/daemon/gateway/future GUI adapters | adapter rendering tests without local policy |
| #1347 | visibility to decisions | visibility policy and decision projection | visibility-connected outcome/expression tests |
| #1348 | AuditTrace schema | runtime audit module | action, withheld, stale, permission, and repair-option audit tests |
| #1349 | silence and quiet-work audit | runtime audit module | withheld work and quiet-work audit tests |
| #1350 | repair options | runtime audit/control integration | stop, narrow, revoke, forget, and re-ground repair tests |
| #1351 | deletion/tombstone redaction | audit/debug/inspection paths | redaction tests across inspection paths |
| #1352 | VisibilityPolicy schema | runtime visibility module | default visibility validation tests |
| #1353 | hidden internal runtime state | inspection/snapshot projection | inspectable-but-hidden tests |
| #1354 | redacted companion-state inspection | companion-state inspection projection | redacted inspection tests |
| #1355 | multi-surface semantics | chat/TUI/CLI/daemon/gateway/future GUI adapters | shared semantics tests across surfaces |
| #1356 | remaining PermissionGrant parent work after closed #1360-#1362 slices | runtime permission contract/evaluator | lifecycle, stale, revoke, reuse, exclusion, and caller-path tests not already covered by completed slices |
| #1357 | conversational grant decisions | chat permission classifier into grant evaluator | typed decision tests with ambiguous and multilingual paraphrases |
| #1358 | waiting_for_permission stored plans | runtime permission wait/resume state | closed before this map; keep stored-plan resume tests as dependency context |
| #1359 | grant visibility and revoke controls | runtime permission visibility/control surfaces | active grant, reuse reason, and revoke inspection tests |

Completed permission dependency context:

- #1360 closed the durable `PermissionGrant` persistence and lifecycle slice.
- #1361 closed standing permission review and renewal semantics.
- #1362 closed host/tool policy integration without bypassing safety.
- Later #1356 work should focus on still-open grant UX, visibility, revoke,
  conversational classification, and any parent acceptance not actually covered
  by those closed slices.

## Test Harness Placement Plan

Contract tests should live beside the owning modules once those modules exist.
Existing PulSeed patterns place runtime-control tests under
`src/runtime/control/__tests__/`, gateway and ingress tests under
`src/runtime/gateway/__tests__/`, chat caller-path tests under
`src/interface/chat/__tests__/`, and automation/runtime bridge tests under
`src/tools/automation/__tests__/`.

Future lanes should add tests in this order:

1. schema or reducer contract tests beside the owning contract module
2. store or state-machine tests beside the owning runtime/memory module
3. adapter tests only after the shared contract exists
4. at least one production caller-path test for any behavior that claims shared
   routing, permission, stale-target rejection, resume, or multi-surface parity

Mock-only tests are insufficient for the parent contracts when the behavior
crosses grounding, runtime control, chat ingress, session registry, or surface
rendering. Keep narrow mock tests for local behavior, then add a caller-path
contract test that lets production routing or interpretation select the path.

## Merge Order Recommendation

1. Merge this map first.
2. Add foundation schemas in dependency order: #1274, #1272, #1279, then the
   remaining #1356 work after accounting for closed #1360, #1361, and #1362.
3. Add state and attention contracts after their inputs exist: #1273, #1278.
4. Add invalidation and control behavior: #1275, #1276.
5. Add decisions, visibility, and audit: #1277, #1280.
6. Add child slices grouped by parent issue, keeping caller-path tests with the
   first production integration in each group.
7. Add multi-surface parity (#1355) only after shared decisions, visibility,
   audit, and permission contracts are consumed by at least one production path.

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
