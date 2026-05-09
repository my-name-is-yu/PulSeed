# Companion Capability Runtime Slice Map

Status: working implementation slice map for #1191.

Source contract:

- `docs/design/infrastructure/companion-capability-runtime.md`
- `docs/design/index.md`
- PR #1566

This map turns the design contract into a thin issue spine. It is not a second
spec. If this map conflicts with the design contract, update this map or the
contract explicitly before implementation.

## Operating Model

Use issues as architectural checkpoints, not tiny TODO lists.

Each slice should be large enough to deliver a coherent boundary with types,
implementation, tests, validation, and a PR. Each slice should be small enough
that a reviewer can verify its invariants without reading unrelated runtime
work.

Recommended workflow:

```text
design contract
  -> 14 implementation slices
  -> one Codex goal per slice
  -> one PR per slice unless the slice is explicitly split
  -> final gap-audit goal against the whole contract
```

Do not run one open-ended goal to "implement all of #1191". The risk is boundary
collapse between readiness, admission, autonomy, projection, and execution.

## Global Invariants

Every slice must preserve these invariants:

- `can execute != may initiate`.
- Asset presence is not capability readiness.
- Readiness is technical execution substrate state only.
- Admission and autonomy are separate from readiness.
- Runtime control remains the final admission point when execution is selected.
- Normal companion UX presents the next best safe action, not a capability
  catalog.
- Docs, status, demo, TUI diagnostics, operator, and debug surfaces must not
  overstate capability.
- Dream procedural hints are internal planning hints, not skills, plugins, or
  execution authority.
- Soil, Knowledge, Dream, audit, and readiness internal loops may be
  default-autonomous only within the narrow internal low-risk class.
- Protected targets cannot be directly created, appended, updated, overwritten,
  deleted, or published by default-autonomous internal metabolism.
- Freeform semantic decisions must not use keyword, regex, `includes`, title
  matching, or language phrase tables as the primary mechanism.
- Production caller-path tests are required for behavior that crosses runtime,
  chat, gateway, permission, or external-surface boundaries.

## Dependency Order

```text
1 Asset Registry And Provenance
  -> 2 Skill Bundle Compatibility
  -> 3 Foreign Plugin And MCP Compatibility
  -> 4 Capability Graph

6 Verification And Audit Records
  -> 5 Readiness Evaluator
  -> 7 Admission Policy Evaluation
  -> 8 Autonomy Governor
  -> 10 CompanionActionProjection

4 Capability Graph
  -> 5 Readiness Evaluator
  -> 9 Default-Autonomous Internal Metabolism
  -> 11 External Surface Gateway Contracts
  -> 12 Status Docs And Operator Projection

13 Production Caller-Path Test Matrix
  -> 14 Final Design Gap Audit
```

Some slices can run in parallel after their owners are separated:

- Slice 2 and Slice 3 can run after Slice 1 skeletons exist.
- Slice 6 can start in parallel with Slice 1.
- Slice 11 can start with contract tests, but should not claim completion until
  Slices 5, 7, 8, and 10 exist.

## Issue Spine

| Slice | Title | Primary dependency | Outcome |
| --- | --- | --- | --- |
| 1 | Asset Registry And Provenance | Design contract | Durable asset records and provenance. |
| 2 | Skill Bundle Compatibility | 1 | Imported skill bundles preserved as assets. |
| 3 | Foreign Plugin And MCP Compatibility | 1, 6 | Quarantine, mapping, and operation-specific MCP gates. |
| 4 | Capability Graph | 1, 2, 3 | Capability candidates projected from assets and runtime state. |
| 5 | Readiness Evaluator | 4, 6 | Operation-specific technical readiness snapshots. |
| 6 | Verification And Audit Records | Design contract | Operation-specific evidence and audit store. |
| 7 | Admission Policy Evaluation | 5, 6 | Concrete operation admission separate from readiness. |
| 8 | Autonomy Governor | 7 | Autonomy decisions separate from execution and expression. |
| 9 | Default-Autonomous Internal Metabolism | 5, 7, 8 | Safe internal loops for Soil, Knowledge, Dream, audit, readiness. |
| 10 | CompanionActionProjection | 8 | Next-best safe action projection for normal UX. |
| 11 | External Surface Gateway Contracts | 7, 8, 10 | Gateway/chat/external-surface separation. |
| 12 | Status Docs And Operator Projection | 5, 7, 8, 10 | Truthful status/docs without normal UX cataloging. |
| 13 | Production Caller-Path Test Matrix | 5-12 | Cross-boundary tests for real entrypoint shapes. |
| 14 | Final Design Gap Audit | all slices | Whole-contract gap sweep and follow-up issues. |

## Slice 1: Asset Registry And Provenance

Owner files:

- new `src/runtime/assets/` or equivalent runtime asset boundary
- `src/interface/cli/commands/setup/import/`
- `src/runtime/skills/skill-registry.ts`
- `src/runtime/foreign-plugins/`
- `src/runtime/builtin-integrations.ts`

Depends on:

- Design contract only.

Must implement:

- Durable `Asset` records for skill bundles, native plugins, foreign plugins,
  MCP server configs, builtin integrations, interactive automation providers,
  notifiers, Soil surfaces, Knowledge surfaces, Dream procedural hints, runtime
  tools, and external connectors.
- Provenance fields: source agent, source path, imported path, checksum,
  version, compatibility report ref, readiness ref, status.
- Explicit asset kind vocabulary.
- Read/list/search surfaces for assets that do not imply execution readiness.

Must not implement:

- Readiness evaluation.
- Admission or autonomy.
- Runtime execution.
- User-facing capability catalog.

Required tests:

- Asset presence never renders as executable.
- Builtin `available` becomes asset evidence only.
- Imported asset provenance survives list/show/search.
- Unknown or invalid asset kinds fail closed.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 1, Asset Registry And Provenance, for #1191.

Read docs/design/infrastructure/companion-capability-runtime.md and
tmp/companion-capability-runtime-slice-map.md. Implement only the asset
registry/provenance boundary. Do not implement readiness, admission, autonomy,
or execution.

Preserve the global invariants. Add focused tests proving asset presence and
builtin `available` do not become executable capability claims. Open a ready PR.
```

## Slice 2: Skill Bundle Compatibility

Owner files:

- `src/runtime/skills/skill-registry.ts`
- `src/runtime/skills/skill-parser.ts`
- `src/interface/cli/commands/skills.ts`
- `src/interface/cli/commands/setup/import/`

Depends on:

- Slice 1.

Must implement:

- Skill import and install as a bundle, not only `SKILL.md`.
- Preservation of `scripts/`, `examples/`, `templates/`, `assets/`,
  `references/`, and relative references.
- Bundle manifest/checksum records.
- Dialect/source/provenance metadata.
- Fail-closed handling for unresolved tool references.

Must not implement:

- Automatic rewriting of imported skills.
- Automatic generation of `SKILL.md` from Dream.
- Treating a skill as executable authority by itself.

Required tests:

- Skill bundle with relative directories is preserved.
- `search/list/show` exposes the bundle without rewriting it.
- Unknown tool references remain advisory and non-executable.
- User-authored skill files are protected targets for default-autonomous writes.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 2, Skill Bundle Compatibility, for #1191.

Scope this PR to imported/user-authored skill bundle preservation and metadata.
Do not implement capability execution, autonomy, or Dream-generated skills.

Required tests: preserve relative scripts/examples/templates/assets, unresolved
tool references stay advisory, and protected user-authored skills cannot be
directly modified by default-autonomous internal metabolism.
```

## Slice 3: Foreign Plugin And MCP Compatibility

Owner files:

- `src/runtime/foreign-plugins/`
- `src/runtime/plugin-loader.ts`
- `src/runtime/types/plugin.ts`
- setup import MCP paths under `src/interface/cli/commands/setup/import/`
- MCP bridge/config modules if present

Depends on:

- Slice 1.
- Slice 6 for verification references, or a temporary local interface that Slice
  6 later owns.

Must implement:

- Foreign plugin copied disabled/quarantined with compatibility report.
- `convertible` or manifest-compatible never means runtime-loadable.
- Operator review as durable `CompatibilityReviewRecord`.
- MCP import states: config imported, enabled, server spawnable, tool list
  available, alias mapped, auth/env valid, operation contract mapped,
  operation-specific verified, blocked.
- Side-effecting MCP verification keyed by provider, server, tool,
  operation kind, payload class, risk class, and side-effect profile.

Must not implement:

- Loading foreign plugin code from quarantine.
- Treating read-only MCP smoke as proof for send/write/publish/delete/mutate.
- Autonomous MCP or foreign plugin execution.

Required tests:

- Compatible foreign plugin with network permission remains quarantined and not
  loaded by `PluginLoader`.
- Imported MCP server is non-executable until all operation-specific gates pass.
- Read-only MCP smoke does not render side-effecting tools executable.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 3, Foreign Plugin And MCP Compatibility, for #1191.

Implement quarantine/review/report states and MCP operation-specific mapping.
Do not load foreign plugin code from quarantine. Do not treat MCP read-only
smoke as side-effecting verification. Add negative tests for both paths.
```

## Slice 4: Capability Graph

Owner files:

- new capability graph module under runtime or platform observation
- `src/platform/observation/capability-registry.ts`
- `src/platform/observation/types/capability.ts`
- `src/runtime/builtin-integrations.ts`
- plugin loader state, MCP config, notifier config, Soil/Knowledge/Dream anchors

Depends on:

- Slices 1, 2, 3.

Must implement:

- Capability candidates from assets and runtime state.
- Provider refs and required config/auth/admission metadata.
- Supported operations, side effect profile, privacy profile, risk profile,
  reversibility, verification profile.
- Capability dependency graph examples for Slack notification, browser
  workflow, Soil query, Knowledge search, Dream procedural hint use.

Must not implement:

- Readiness truth.
- Admission/autonomy decisions.
- User-facing catalog as normal companion UX.

Required tests:

- Asset candidates become capability candidates only with explicit operation
  contracts.
- Dream procedural hints are planning hints, not execution authority.
- Soil/Knowledge surfaces become knowledge capability candidates without
  external-action authority.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 4, Capability Graph, for #1191.

Build the projection from asset/runtime state into capability candidates. Keep
readiness, admission, autonomy, and normal UX projection out of scope. Add tests
that Dream hints and Soil/Knowledge surfaces remain non-authoritative.
```

## Slice 5: Readiness Evaluator

Owner files:

- new readiness evaluator module
- `src/platform/observation/types/capability.ts`
- `src/platform/observation/capability-registry.ts`
- `src/runtime/builtin-integrations.ts`
- verification/audit store from Slice 6

Depends on:

- Slice 4.
- Slice 6.

Must implement:

- `ReadinessSnapshot` as technical execution substrate state.
- Projection from legacy `available | missing | requested | acquiring |
  verification_failed` into readiness evidence only.
- Operation-specific readiness gates: stored, discoverable, loadable,
  compatible, configured, authenticated, executable_verified, degraded, blocked.
- Safe labels for status/operator surfaces.

Must not implement:

- Permission, relationship policy, quieting, privacy, notification policy, or
  runtime-control authority inside readiness.
- Autonomous permission.
- Normal companion UX decisions.

Required tests:

- Builtin `available` does not become executable.
- Native plugin loaded but missing config is not executable.
- Notifier route configured without successful send is not
  executable-verified.
- Read-only evidence does not prove side-effecting readiness.
- Labels derive from readiness snapshots, not raw asset presence.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 5, Readiness Evaluator, for #1191.

Readiness answers only whether the technical execution substrate is ready for a
specific operation if admission approves. It must not include permission,
quieting, relationship policy, notification policy, or autonomy. Add tests for
legacy `available`, missing config, notifier send evidence, and side-effecting
operation separation.
```

## Slice 6: Verification And Audit Records

Owner files:

- new runtime verification/audit modules
- `src/runtime/store/`
- existing audit/event/log stores where appropriate

Depends on:

- Design contract only.

Must implement:

- `CapabilityAuditRecord`.
- `CapabilityVerificationRef`.
- Verification classes: parse validation, manifest validation, configuration
  validation, auth probe, permission probe, smoke execution,
  production caller path, post-execution verification, reuse outcome, operator
  review.
- Evidence separation between imported, parsed, loaded, configured, smoke
  verified, production succeeded, production failed, user corrected, revoked.

Must not implement:

- Trust widening from a single event.
- Admission decisions.
- User-visible output policy.

Required tests:

- Read-only smoke, side-effecting smoke, production success, and operator review
  are distinct events.
- `permission_probe` does not replace admission evaluation.
- Failed production caller path can downgrade/degrade readiness evidence.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 6, Verification And Audit Records, for #1191.

Create operation-specific verification and audit records. Keep permission probe,
smoke, production caller path, and operator review distinct. Do not implement
readiness or autonomy beyond the record types and storage needed by later
slices.
```

## Slice 7: Admission Policy Evaluation

Owner files:

- new admission policy module
- `src/runtime/permission-grant-decision.ts`
- `src/tools/permission-grant-evaluator.ts`
- `src/runtime/control/`
- notification routing and channel policy boundaries

Depends on:

- Slices 5 and 6.

Must implement:

- `AdmissionPolicyEvaluation`.
- Operation-scoped evaluation over actor, surface, target, payload class,
  provider, auth state, permission grants, relationship policy, quieting,
  privacy, runtime control refs, notification policy.
- Results: allowed, approval_required, suppressed, prohibited.
- Expiry and invalidation by target/provider/auth/payload/policy epoch changes.

Must not implement:

- Technical readiness.
- Autonomy level selection.
- Normal companion expression.

Required tests:

- Capability can be executable-verified while autonomous notification remains
  approval_required or suppressed.
- Inbound message permission is not outbound notification permission.
- Reply target availability is not session resume permission.
- One-time approval does not become standing authority.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 7, Admission Policy Evaluation, for #1191.

Implement concrete operation admission separate from readiness and autonomy.
Tests must prove inbound permission, outbound notification, reply target,
runtime-control authority, and approval reuse remain separate.
```

## Slice 8: Autonomy Governor

Owner files:

- new autonomy governor module
- runtime control integration boundary
- permission/admission consumers
- trust/profile/feedback consumers where already available

Depends on:

- Slice 7.

Must implement:

- `AutonomyDecisionInput` and `AutonomyDecision`.
- Levels: advisory, prepare_only, user_directed_execute,
  autonomous_low_risk, approval_required, prohibited.
- Conservative handling for external mutation, notification, destructive
  action, privacy-sensitive reads, high blast radius, degraded readiness, and
  blocked readiness.
- Cache invalidation on revocation, correction, tombstone, quieting, suspend,
  or policy downgrade.

Must not implement:

- Execution.
- User-visible expression.
- Default internal metabolism policy beyond consuming its classifier from Slice
  9 if already available.

Required tests:

- `approval_required`, `prohibited`, and `prepare_only` outcomes for risky or
  blocked operations.
- Positive feedback does not widen interruption or external-action authority.
- Negative feedback reduces autonomy or requires confirmation.
- Memory, route config, past execution, auth session, MCP enabled state, and
  notification subscription do not imply permission.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 8, Autonomy Governor, for #1191.

Implement autonomy decisions after readiness and admission. Do not execute or
render user-facing output. Preserve fail-closed defaults for external side
effects and add tests proving memory/config/past success/auth do not grant
autonomous authority.
```

## Slice 9: Default-Autonomous Internal Metabolism

Owner files:

- `src/platform/soil/`
- `src/platform/knowledge/`
- `src/platform/dream/playbook-memory.ts`
- audit/readiness modules from Slices 5 and 6
- autonomy governor integration

Depends on:

- Slices 5, 7, 8.

Must implement:

- `InternalAutonomyDefault` classifier.
- Default `autonomous_low_risk` path for local, inspectable, reversible or
  append-only, non-interruptive, internal-state-only operations.
- Allow Soil retrieval/projection into generated cache/snapshot/review areas.
- Allow Knowledge recall/consolidation/quarantine/internal generated learning
  records.
- Allow Dream procedural hint selection, reuse tracking, demotion, confidence
  updates.
- Allow audit append and readiness observation.

Must not implement:

- Direct create, append, update, overwrite, delete, or publish into protected
  targets.
- External publish/open.
- Cross-scope auto-apply.
- Deletion.
- Notification.
- Browser or desktop operation.
- Side-effecting MCP.
- Foreign plugin execution.

Required tests:

- Safe internal operations receive `autonomous_low_risk`.
- Protected targets return quarantine/proposal/review/approval-required.
- Create, append, update, overwrite, delete, and publish to protected targets
  are all blocked from the internal default.
- External side effects never pass through the internal default.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 9, Default-Autonomous Internal Metabolism, for #1191.

Implement a narrow internal autonomy default for Soil, Knowledge, Dream, audit,
and readiness loops. It should help capability growth without granting external
authority. Protected targets and external side effects must be blocked with
explicit tests for create/append/update/overwrite/delete/publish.
```

## Slice 10: CompanionActionProjection

Owner files:

- new companion action projection module
- `src/interface/chat/`
- TUI/GUI expression surfaces if present
- status/debug consumers only for inspectability

Depends on:

- Slice 8.

Must implement:

- `CompanionActionProjection`.
- User-visible action kinds: stay_silent, suggest, prepare_draft,
  ask_for_approval, execute_now, challenge, refuse_with_alternative,
  digest_later.
- Mapping from autonomy decisions to next best safe action.
- Hidden reason refs for audit/debug.
- Prepared artifact refs and approval request refs where useful.

Must not implement:

- Runtime-control admission bypass.
- Raw readiness/admission/autonomy dump in normal chat or GUI.
- Capability catalog UX.

Required tests:

- `approval_required` prepares draft and/or asks for approval without executing.
- `prohibited` returns an alternative, not raw policy text.
- Suppressed or quieted work stays silent or digests later.
- Operator/debug can inspect hidden reasons.
- Normal chat does not become a capability catalog.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 10, CompanionActionProjection, for #1191.

Add the layer after AutonomyDecision and before user-visible expression or
execution. It maps policy outcomes to next-best safe actions. It must not bypass
runtime-control admission and must not dump raw capability state in normal chat.
```

## Slice 11: External Surface Gateway Contracts

Owner files:

- `src/runtime/gateway/ingress-gateway.ts`
- `src/runtime/gateway/chat-session-dispatch.ts`
- `src/runtime/gateway/channel-policy.ts`
- `src/runtime/gateway/*-channel-adapter.ts`
- `src/interface/chat/ingress-router.ts`
- `src/interface/chat/chat-runner.ts`
- `src/interface/chat/cross-platform-session.ts`
- notification routing and dispatcher modules

Depends on:

- Slices 7, 8, 10.

Must implement:

- `ExternalSurface` typed model or adapters into an equivalent model.
- Separation of inbound access, outbound notification permission, reply target,
  notification route config, runtime-control admission, and autonomous
  authority.
- Gateway/chat caller-path integration.

Must not implement:

- Treating route config as permission to initiate conversation.
- Treating runtime event creation as notification.
- Reusing stale browser/session/auth state across mismatched boundaries.

Required tests:

- Gateway/chat caller-path tests through real ingress shape:
  channel adapter or `IngressGateway` policy where relevant,
  `dispatchGatewayChatInput`, `processIncomingMessage`,
  `ChatRunner.executeIngressMessage`, `ingress-router`, runtime-control
  admission.
- Inbound access, outbound notification permission, reply target,
  notification route, and runtime-control authority remain separate.
- Stale or previous reply target is rejected.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 11, External Surface Gateway Contracts, for #1191.

Attach the capability runtime contracts to gateway/chat caller paths. Preserve
the separation between inbound permission, outbound notification, reply target,
notification route, runtime-control admission, and autonomous authority.
```

## Slice 12: Status Docs And Operator Projection

Owner files:

- README/docs/status/TUI diagnostic helpers as needed
- `docs/mechanism.md`
- `docs/configuration.md`
- `docs/index.md`
- TUI/status/debug/operator projection modules

Depends on:

- Slices 5, 7, 8, 10.

Must implement:

- Truthful projection rules for README, docs, demos, status, TUI diagnostics,
  operator views, and debug surfaces.
- Safe labels based on readiness plus explicit admission/autonomy state.
- Normal companion UX uses `CompanionActionProjection`, not raw state.

Must not implement:

- Capability catalog in normal chat/GUI.
- Overstating configured/imported capability as executable.
- Hiding degraded/blocked state from operator/debug surfaces.

Required tests:

- Docs/status/operator labels derive from readiness snapshots and
  admission/autonomy state.
- Normal chat/GUI presents next best safe action instead of raw state dump.
- Demo/operator surfaces that imply autonomous action require evidence.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 12, Status Docs And Operator Projection, for #1191.

Implement truthfulness surfaces for docs/status/operator/debug without turning
normal companion UX into a capability catalog. Normal UX should use
CompanionActionProjection and next-best safe action language.
```

## Slice 13: Production Caller-Path Test Matrix

Owner files:

- test harnesses under relevant runtime/gateway/chat/platform test directories
- shared fixtures for capability runtime contracts

Depends on:

- Slices 5 through 12.

Must implement:

- A matrix that exercises production entrypoint shapes for readiness, admission,
  autonomy, projection, gateway/chat, external surfaces, and internal metabolism.
- Test fixtures that avoid precomputed lower-level shortcuts when caller-path
  behavior is being asserted.

Must not implement:

- New behavior beyond test harness support.
- Mock-only coverage for a claim that requires a production boundary.

Required tests:

- Freeform operation planning and route selection include paraphrases,
  multilingual wording, ambiguous input, and stale/previous-target rejection.
- Tests fail if keyword/regex/includes/title matching drives freeform intent.
- Runtime event creation alone does not dispatch notification.
- Browser session stale/mismatch/expiry/supersession fails closed.
- One-time approval cannot be reused as standing autonomous authority.

Suggested Codex goal prompt:

```text
Goal: Implement Slice 13, Production Caller-Path Test Matrix, for #1191.

Add the cross-boundary tests that prove the already-implemented slices hold on
real caller paths. Prefer production entrypoint shapes over mock-only lower-level
tests. Do not add new runtime behavior except test harness support.
```

## Slice 14: Final Design Gap Audit

Owner files:

- all touched slices
- `docs/design/infrastructure/companion-capability-runtime.md`
- issue/PR audit artifacts

Depends on:

- All previous slices.

Must implement:

- No feature implementation unless the audit finds a concrete gap.
- A gap report mapping every design requirement to code/test evidence.
- Focused follow-up issues for any remaining gaps.
- Optional cleanup PRs only for blocker-grade gaps.

Must not implement:

- Broad refactors unrelated to the contract.
- New feature scope beyond closing documented gaps.

Required tests:

- Re-run the relevant test matrix.
- Re-run docs/status checks.
- Verify no capability catalog UX regressed into normal chat/GUI.

Suggested Codex goal prompt:

```text
Goal: Final gap audit for #1191 Companion Capability Runtime.

Read docs/design/infrastructure/companion-capability-runtime.md and every PR
merged for Slices 1-13. Produce a requirement-to-evidence map, identify gaps,
fix only concrete blocker-grade gaps, and create focused follow-up issues for
anything that should not be fixed in this audit PR.
```

## Issue Creation Notes

When turning this map into GitHub issues:

- Use English issue titles and bodies.
- Link #1191 and PR #1566.
- Link this tmp map only as a local working artifact, not as the canonical
  contract.
- Make the design doc the source of truth.
- Keep each issue's acceptance criteria focused on invariants and tests.
- Do not include a line-by-line TODO list.

Recommended issue title format:

```text
Implement #1191 slice N: <slice title>
```

Recommended issue body sections:

```text
## Context
## Scope
## Owner Files
## Must Preserve
## Out Of Scope
## Required Tests
## Suggested Codex Goal Prompt
```
