# Companion Capability Runtime Gap Audit

> Status: Archived design document. This is retained for context and is not current operating guidance.

Status: final design gap audit for Companion Capability Runtime after implementation slices 1-13.

This audit maps the Companion Capability Runtime contract to code, tests,
and documentation evidence after the slice-map implementation run. It is not a
new contract; the source contract remains
[`companion-capability-runtime.md`](companion-capability-runtime.md).

## Scope

Audited source references:

- the Companion Capability Runtime design contract
- the slice map that introduced the implementation order
- the implementation slices that landed the contract in code and tests

Slice 14 did not add feature runtime behavior. The only remaining gaps found are
follow-up integration work that should stay focused and independently reviewed.

## Requirement-To-Evidence Map

| Requirement | Evidence | Audit result |
| --- | --- | --- |
| Preserve `can execute != may initiate`. | `src/platform/observation/capability-readiness.ts`, `src/runtime/control/admission-policy.ts`, `src/runtime/control/autonomy-governor.ts`, `src/runtime/control/capability-status-projection.ts`, and tests under `src/runtime/control/__tests__/`. | Covered. Readiness, admission, autonomy, and execution labels are separate typed decisions. |
| Asset presence is not capability readiness. | `src/runtime/assets/types.ts` exposes `AssetExecutionClaim` as `executable: false`; `src/runtime/assets/registry.ts` returns asset views without execution authority; `src/runtime/assets/__tests__/asset-registry.test.ts`. | Covered. Assets remain provenance/search records. |
| Store source provenance for capability-bearing assets. | `AssetRecordSchema`, `AssetRegistry`, setup import asset recording in `src/interface/cli/commands/setup/import/apply.ts`, and tests for asset registry/setup import behavior. | Covered. |
| Preserve skill bundles as bundles, not rewritten single files. | `src/runtime/skills/skill-bundle.ts`, `src/runtime/skills/skill-registry.ts`, and `src/runtime/skills/__tests__/skill-registry.test.ts`. | Covered. Relative `scripts`, `examples`, `templates`, `assets`, and `references` are represented in bundle manifests. |
| Keep imported skills advisory unless mapped to verified capabilities. | `SkillBundleCompatibilityMetadata.execution_mapping_status`, `unsupported_references`, and skill registry asset metadata. | Covered. Unknown references block execution mapping while preserving discoverability. |
| Quarantine or disable foreign plugins until explicit review, adapter, and smoke gates exist. | `src/runtime/foreign-plugins/types.ts`, `src/runtime/foreign-plugins/compatibility.ts`, setup import discovery/apply flow, and `src/runtime/__tests__/foreign-plugin-compatibility.test.ts`. | Covered. `runtime_loadable` remains false for foreign compatibility reports and review records. |
| Require operation-specific MCP verification. | `src/runtime/mcp/compatibility.ts` and `src/runtime/mcp/__tests__/compatibility.test.ts`. | Covered. MCP import summary is non-executable; operation compatibility requires provider, server, tool, operation, payload, risk, and side-effect keyed verification. |
| Treat Dream procedural hints as planning hints, not skills/plugins/execution authority. | `src/platform/observation/capability-graph.ts`, docs in `docs/configuration.md`, and capability graph tests. | Covered. Dream assets project planning-hint-only capability candidates. |
| Build a capability graph from assets and runtime stores. | `src/platform/observation/capability-graph.ts`, `src/platform/observation/types/capability.ts`, and `src/platform/observation/__tests__/capability-graph.test.ts`. | Covered for the implemented provider families and explicit operation contracts. |
| Evaluate technical readiness per operation. | `src/platform/observation/capability-readiness.ts`, `CapabilityReadinessSnapshotSchema`, and `src/platform/observation/__tests__/capability-readiness.test.ts`. | Covered. Snapshots include operation, provider, asset, payload, risk, side-effect, evidence, stale refs, and safe labels. |
| Exclude permission, admission, autonomy, quieting, privacy, and notification policy from readiness. | `capability-readiness.ts` consumes verification evidence only; admission/autonomy tests assert the downstream gates separately. | Covered. |
| Store verification and audit records as operation-specific evidence. | `src/runtime/store/capability-verification-schemas.ts`, `src/runtime/store/capability-verification-store.ts`, and `src/runtime/__tests__/capability-verification-store.test.ts`. | Covered as durable store and evidence semantics. Follow-up work covers writing these records from production execution outcomes. |
| Keep permission probes from replacing concrete admission. | `readinessEvidenceEffect()` and `capability-verification-store.test.ts`. | Covered. `permission_probe` has readiness effect `none`. |
| Evaluate concrete operation admission separately from readiness and autonomy. | `src/runtime/control/admission-policy.ts` and `src/runtime/control/__tests__/admission-policy.test.ts`. | Covered. Actor, surface, target, permission grant, auth, runtime-control, notification, quieting, privacy, and relationship inputs are scoped and expiring. |
| Preserve permission-grant scope, revocation, staleness, and one-time approval boundaries. | `src/runtime/store/permission-grant-store.ts`, `src/tools/permission-grant-evaluator.ts`, `src/runtime/control/runtime-control-service.ts`, `src/interface/chat/__tests__/cross-platform-session.test.ts`, and `src/tools/__tests__/executor.test.ts`. | Covered by production caller-path tests, including consumed one-time grant rejection. |
| Decide autonomy after readiness and admission. | `src/runtime/control/autonomy-governor.ts` and `src/runtime/control/__tests__/autonomy-governor.test.ts`. | Covered. Matching operation scope, admission, readiness, policy, auth, guardrail, backpressure, feedback, and invalidation inputs feed decisions. |
| Keep default-autonomous internal metabolism narrow and local. | `src/runtime/control/internal-autonomy-default.ts` and autonomy governor tests. | Covered. Soil, Knowledge, Dream, audit, and readiness classes are eligible only for local, inspectable, reversible or append-only internal targets. |
| Block protected targets and external effects from internal autonomy. | `internal-autonomy-default.ts`, `src/runtime/skills/skill-bundle.ts`, and tests for protected skill mutation classification and autonomy decisions. | Covered. |
| Project normal companion UX as next-best safe action, not a capability catalog. | `src/runtime/control/companion-action-projection.ts`, `src/runtime/control/capability-status-projection.ts`, and tests in `companion-action-projection.test.ts` and `capability-status-projection.test.ts`. | Covered. Normal companion projections suppress capability catalog and raw policy state. |
| Keep operator/status/debug surfaces truthful about readiness plus admission/autonomy. | `src/runtime/control/capability-status-projection.ts`, `src/interface/cli/commands/operator-binding-status.ts`, `docs/status.md`, `docs/runtime.md`, and `README.md`. | Covered for projection shape and printing. Follow-up work covers collecting live runtime projections into operator status. |
| Keep inbound access, outbound notification permission, reply targets, notification routes, runtime-control admission, and autonomous authority separate. | `src/runtime/gateway/channel-policy.ts`, `src/interface/chat/ingress-router.ts`, `src/interface/chat/cross-platform-session.ts`, `src/runtime/control/runtime-control-service.ts`, and gateway/chat tests. | Covered by Slice 11 and Slice 13 caller-path tests. |
| Keep runtime event creation separate from user notification. | `src/runtime/control/__tests__/runtime-control-service.test.ts` and notification dispatcher/outbox tests from Slice 13. | Covered. Runtime control events do not dispatch notification without the notification dispatcher path. |
| Fail closed on stale or mismatched browser/auth/session boundaries. | `src/tools/automation/InteractiveAutomationTools.ts` and `src/tools/automation/__tests__/InteractiveAutomationTools.test.ts`. | Covered. |
| Use structured semantic classification or typed state for freeform routing; do not add keyword/regex/includes matching as primary intent logic. | `src/interface/chat/freeform-route-classifier.ts`, `src/interface/chat/chat-runner.ts`, `src/interface/chat/__tests__/chat-runner.test.ts`, and `src/interface/chat/__tests__/cross-platform-session.test.ts`. | Covered for the chat and gateway RunSpec caller paths. Follow-up work covers non-chat operation-plan assembly. |
| Exercise production caller-path shapes where boundaries cross chat, gateway, runtime, permission, or external surfaces. | Slice 13 tests in `chat-runner.test.ts`, `cross-platform-session.test.ts`, `runtime-control-service.test.ts`, `InteractiveAutomationTools.test.ts`, and `executor.test.ts`. | Covered for the current slice-map boundary set. |

## Remaining Follow-Up Work

- Collect live capability runtime projections in operator status.
- Persist capability verification and audit records from production
  execution.
- Assemble unified capability OperationPlans for non-chat proposals.

These are real integration gaps, but they are not blocker-grade gaps for the
slice-map spine because the underlying contracts, evidence stores, projections,
and caller-path regression tests already exist.

## Closing Assessment

The slice-map implementation now has concrete owner boundaries for asset
provenance, skill bundles, foreign plugin and MCP compatibility, capability
graph projection, readiness, verification/audit storage, admission, autonomy,
internal metabolism, companion action projection, external-surface contracts,
operator/status projection, and production caller-path regression coverage.

The design invariants remain intact:

- readiness stays technical and operation-specific,
- admission and autonomy remain downstream decisions,
- execution still routes through existing executors and runtime-control gates,
- normal companion UX stays next-best safe action oriented,
- foreign assets and Dream hints do not become execution authority, and
- freeform semantic routing is structured rather than keyword-driven.
