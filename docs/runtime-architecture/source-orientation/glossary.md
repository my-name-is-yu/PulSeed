# Glossary

> Status: Current public glossary. This page explains PulSeed terminology at the
> product and architecture boundary; exact runtime behavior remains owned by
> source code, schemas, tests, and operating docs.
> Doc status: active_design_contract
> Grounding use: design_context

Primary map: [Source Orientation](./source-orientation-map.md).

PulSeed uses product language and runtime-contract language together. This
glossary keeps those layers separate so public readers can tell metaphor from
implementation.

| Term | Public meaning | Runtime boundary |
| --- | --- | --- |
| Agentic friend | Product direction: companion software that can remember context, notice change, prepare help, and back off when silence is safer. | Not a claim that every companion workflow is current package behavior. Current behavior is listed in [Status](../../operating/runtime-operations/status.md). |
| DurableLoop | Long-running controller for goals, schedules, verification cycles, and stateful progress. | Owns durable goal orchestration, not every tool action or surface-rendering decision. |
| AgentLoop | Bounded tool-using execution loop for chat turns, task execution, and selected runtime phases. | Executes within budgets, stop conditions, tool policy, and approval boundaries. |
| Attention | The design layer that turns observations, schedules, context, and internal signals into held urges, quiet work, expression candidates, or silence. | Attention does not bypass runtime control, approval, or safety gates. |
| Surface | A governed projection of memory and context into one runtime situation. | Surface is not the full memory store and not permission. Stale, sensitive, forbidden, or out-of-scope memory can be withheld. |
| SituationFrame | Typed snapshot of relevant runtime, memory, goal, and surface context for a decision. | A frame is evidence input, not authority to act by itself. |
| CompanionCognitionKernel | Shared advisory boundary that turns typed surface/runtime/attention/memory refs into candidate action, response, memory-use audit, authority handoff, commitment handoff, reflection, and replay refs. | It does not execute side effects, grant approval, mutate canonical memory, deliver notifications, or expose raw refs to normal surfaces. |
| InterventionPolicy | Policy that decides when PulSeed may interrupt, hold, suppress, ask, or stay quiet. | It narrows expression and action; it does not grant execution authority. |
| Readiness | Technical evidence that a capability can perform a specific operation. | Readiness is not permission, admission, or autonomy. |
| Admission | Runtime-control decision that a concrete operation may proceed under current scope, actor, target, state, and policy. | Admission is operation-specific and can fail closed on stale or ambiguous state. |
| Autonomy | Decision about whether PulSeed may initiate or continue work without a fresh user command in this context. | Autonomy is downstream of readiness, admission, risk, permissions, and quieting policy. |
| RuntimeGraph | Durable internal lineage for goals, tasks, sessions, runs, artifacts, reply targets, and related runtime state. | Normal user surfaces should show projections, not raw graph nodes or evidence refs. |
| DB-first | Durable runtime truth is owned by typed SQLite/control/Soil stores rather than ad hoc JSON files. | Some files still exist for config, workspace content, debug/export, IPC spool, or migration input. |
| Soil | Human-readable long-term knowledge and retrieval surface. | Soil is a typed retrieval/projection system, not the universal write owner for runtime state. |
| Dream | Offline memory and knowledge compiler that turns traces into verified records or procedural hints. | Dream hints are planning evidence, not automatic execution authority. |
| Operator/debug surface | A command or view meant for inspection, diagnosis, repair, or integration work. | It may show raw IDs, evidence refs, readiness/admission labels, or policy state that ordinary surfaces hide. |
| Claim ledger | Markdown-embedded JSON ledger for selected high-risk public claims and their evidence/boundary classification. | It is a guardrail for important claims, not a full semantic proof of every docs sentence. |
| Current operating behavior | Behavior backed by current source, schemas, tests, and public operating docs. | Safe for README, start, operate, and reference docs when claim boundaries are explicit. |
| Product design direction | Intended product shape or north-star scenario. | Must not be described as a current package workflow unless backed by code, tests, and operating docs. |
