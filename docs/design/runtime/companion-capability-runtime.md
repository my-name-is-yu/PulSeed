# Companion Capability Runtime

> Status: Public design reference. This page explains PulSeed design intent and architecture rationale; exact runtime behavior is owned by current source code, tests, and operating docs.

> Scope: Companion capability runtime design rationale under [Companion Autonomy Spine](../companion/companion-autonomy-spine.md).

This document defines the capability substrate and autonomy governor needed for
PulSeed to become reliable lifelong companion software. It connects imported
agent assets, native tools, plugins, MCP servers, automation providers,
notifiers, verified procedural hints, runtime policy, and audit into one shared
contract.

The core distinction is:

```text
can execute != may initiate
```

PulSeed should be able to use a broad tool surface when the user explicitly
directs it. It should also use core internal companion substrates autonomously by
default when the operation is local, reversible, low-risk, and needed for
continuity, learning, or capability growth. External actions and interruptions
remain governed by readiness, verification, reversibility, external side
effects, privacy, relationship policy, quieting policy, trust, confidence, and
current runtime state.

## Purpose

Lifelong companion software needs a larger and more honest capability model than
a task runner, chatbot, or plugin loader.

It must answer:

```text
What assets and integrations does PulSeed have?
What can they do?
Can they actually execute right now?
May PulSeed use them on its own in this context?
What must be prepared, verified, approved, suppressed, or audited first?
```

The answer is the Companion Capability Runtime:

```text
Imported and native assets
  -> Asset Registry
  -> Capability Graph
  -> Readiness Evaluator
  -> Operation Planner
  -> Autonomy Governor
  -> Companion Action Projection
  -> Execution Runtime
  -> Verification, audit, trust, and procedural-hint feedback
```

The runtime is not a replacement for existing tools. It is the layer that makes
their availability, safety, and autonomy semantics consistent across chat, TUI,
daemon, schedules, external connectors, future GUI surfaces, and public demos.

## Non-Goals

This design does not define:

- a GUI layout
- companion copywriting
- a universal plugin ABI for every external ecosystem
- automatic rewriting of imported skills or foreign plugins
- automatic generation of executable skills from Dream
- permission bypasses for user-directed actions
- an engagement-maximizing notification policy
- a complete first implementation package

It defines the contract that focused implementation increments must preserve.

## Spine Position

The Companion Capability Runtime sits beside the runtime control plane and below
attention and expression policy.

```text
governed memory and Surface
  -> companion state and attention
  -> operation intent
  -> capability readiness
  -> autonomy governor
  -> companion action projection
  -> runtime control admission when execution is selected
  -> execution, expression, preparation, approval request, alternative, or silence
  -> audit and feedback
```

Boundary rules:

```text
asset present != capability available
capability available != capability verified
capability verified != permission to initiate
runtime event != notification
notification route != permission to speak
memory/procedural hint != executable skill
authenticated session != reusable session
user-directed execution != future autonomous authority
```

## Current Production Boundaries

The design must attach to existing caller paths before new stores are added.

| Design object | Current code or doc boundary | Design implication |
| --- | --- | --- |
| Local skills | `src/runtime/skills/skill-registry.ts`, `src/runtime/skills/skill-parser.ts`, `src/interface/cli/commands/skills.ts` | Skills are discoverable and readable instruction assets. They are not executable capabilities by themselves. |
| Setup import | `src/interface/cli/commands/setup/import/` | Imports from Hermes/OpenClaw already find skills, MCP servers, plugins, provider config, Telegram config, and user files. Capability Runtime should extend this rather than inventing another migration path. |
| Foreign plugins | `src/runtime/foreign-plugins/compatibility.ts`, `src/runtime/foreign-plugins/types.ts` | Foreign plugin import already produces compatibility status and permission summaries. Execution requires a later review, adapter, and smoke gate. |
| Native plugin loader | `src/runtime/plugin-loader.ts`, `src/runtime/types/plugin.ts` | Native plugins load through typed manifest and interface validation, then register adapters, data sources, notifiers, or schedule sources. Loaded does not mean autonomously selectable. |
| Builtin integrations | `src/runtime/builtin-integrations.ts`, `src/runtime/types/builtin-integration.ts` | Builtins must report the same readiness semantics as user-installed assets. Core internal builtins may have default autonomous admission for low-risk local metabolism; external or side-effecting builtins may not. |
| Capability registry | `src/platform/observation/capability-registry.ts`, `src/platform/observation/types/capability.ts` | Existing status values are too coarse for companion-facing truthfulness and operator status projection. They should be extended or projected into readiness states. |
| Plugin matching and trust | `src/platform/observation/capability-detector.ts`, `src/platform/traits/trust-manager.ts` | Trust and match score help rank providers, but they must not collapse readiness, policy, and permission into one auto-select flag. |
| Dream procedural hints | `src/platform/dream/playbook-memory.ts`, `src/orchestrator/execution/task/task-side-effects.ts`, `src/orchestrator/execution/task/task-lifecycle.ts` | Dream stores verified procedural hints in the current playbook memory implementation. Hint selection, reuse tracking, and demotion are default-autonomous internal metabolism after readiness; hints are still not auto-generated `SKILL.md` files and not direct execution authority. |
| Soil projections and publish surfaces | `src/platform/soil/`, `src/platform/soil/open.ts`, `src/platform/soil/publish/`, `src/platform/soil/display/`, `src/runtime/builtin-integrations.ts` | Soil retrieval, local projection, context compilation, and materialization into generated cache, snapshot, or review areas are default-autonomous internal metabolism after readiness. External publish/open operations and any direct create, append, update, overwrite, delete, or publish into protected targets require separate admission and autonomy. |
| Knowledge manager and transfer | `src/platform/knowledge/`, `src/platform/knowledge/transfer/`, `src/platform/knowledge/public-api.ts` | Search, recall, learning, candidate transfer detection, consolidation, and quarantine can be default-autonomous internal metabolism after readiness. Cross-scope auto-apply, deletion, or external exposure requires stricter admission. |
| Interactive automation | `src/runtime/interactive-automation/`, `src/tools/automation/InteractiveAutomationTools.ts` | Provider registration, availability, session/auth state, backpressure, and tool permission must feed readiness and autonomy decisions. |
| Runtime auth and guardrails | `docs/design/runtime/runtime-auth-browser-guardrails.md`, `src/runtime/control/`, `src/runtime/guardrails/` | Auth handoffs, browser sessions, guardrails, and backpressure are hard readiness inputs and fail-closed blockers. |
| Gateway ingress and channel adapters | `src/runtime/gateway/ingress-gateway.ts`, `src/runtime/gateway/chat-session-dispatch.ts`, `src/runtime/gateway/channel-policy.ts`, `src/runtime/gateway/*-channel-adapter.ts` | Inbound access, channel routing, identity, and reply dispatch are ingress semantics. They are not outbound notification permission or autonomous runtime authority. |
| Chat ingress and route selection | `src/interface/chat/ingress-router.ts`, `src/interface/chat/chat-runner.ts`, `src/interface/chat/cross-platform-session.ts`, `src/interface/chat/freeform-route-classifier.ts` | Gateway and chat input enter typed route selection before execution. Reply targets, runtime-control admission, route kind, and semantic classification must stay explicit typed state. |
| Notification routing | `src/runtime/notification-routing.ts`, `src/runtime/notification-dispatcher.ts`, `src/tools/mutation/ConfigureNotificationRoutingTool/` | Notification routes are delivery configuration, not consent to initiate conversation or external mutation. |
| Permission decisions | `src/runtime/permission-grant-decision.ts`, `src/tools/permission-grant-evaluator.ts`, approval-related chat/tool paths | Permission grants are scoped evidence, not evergreen capability trust or autonomous authority. |
| Runtime control | `docs/design/runtime/runtime-control-plane.md`, `src/runtime/control/runtime-control-service.ts`, `src/runtime/store/`, `src/runtime/session-registry/` | Runtime control owns admission, staleness, authority, visibility, control, and audit for action-bearing operations. |
| Grounding and Surface | `src/grounding/gateway.ts`, `src/grounding/contracts.ts`, grounding providers | Memory and profile context may inform decisions only through governed Surface, not by direct prompt or raw file shortcuts. |
| Docs, demos, status, and operator surfaces | `README.md`, `docs/concepts/mechanism.md`, `docs/operate/configuration.md`, `docs/index.md`, TUI/status/debug/operator views | Docs, demos, status, and operator/debug surfaces must not overstate executable capability. Normal companion UX should prefer the next best safe action over capability-state exposition. |

## Core Objects

### Asset

An `Asset` is something PulSeed can store, inspect, search, or adapt.

```text
Asset
  asset_id
  asset_kind
  source
  source_agent
  source_path
  imported_path
  checksum
  version
  provenance
  compatibility_report_ref
  readiness_ref
  status
```

Asset kinds:

```text
skill_bundle
native_plugin
foreign_plugin
mcp_server
builtin_integration
interactive_automation_provider
notifier
cli_tool
dream_procedural_hint
soil_surface
knowledge_surface
runtime_tool
external_connector
```

Assets are not the execution unit. They are evidence that a possible capability
may exist.

### Capability

A `Capability` is what PulSeed can potentially do.

```text
Capability
  capability_id
  name
  kind
  provider_refs
  source_asset_refs
  required_config
  required_auth
  required_admission
  supported_operations
  risk_profile
  reversibility
  side_effect_profile
  privacy_profile
  verification_profile
  trust_profile
  readiness_state
```

Examples:

```text
send_slack_notification
receive_telegram_message
read_browser_state
run_browser_workflow
operate_desktop_app
query_soil_records
run_code_review_workflow
use_verified_procedural_hint
query_calendar_source
write_external_ticket
```

Capabilities can be backed by multiple assets. A Slack notification capability
may depend on a plugin manifest, local config, credential validity, notifier
registration, notification routing, runtime policy, and a successful smoke send.

### Operation

An `Operation` is a concrete proposed use of one or more capabilities.

```text
OperationIntent
  operation_id
  operation_kind
  requested_by
  user_directed
  source_surface
  target_refs
  required_capability_refs
  reason
  urgency
  reversibility
  external_side_effect
  privacy_sensitivity
  blast_radius
  expected_user_visible_effect
  candidate_payload_ref
  readiness_snapshot_ref
  autonomy_decision_ref
```

Operations, not assets, enter the autonomy governor.

## Asset Registry

The Asset Registry stores source truth for capability-bearing assets.

Responsibilities:

- Preserve imported assets without rewriting them.
- Record source agent, source path, import path, checksum, import time, and
  compatibility notes.
- Keep foreign executable code disabled or quarantined until explicit review and
  verification.
- Expose read/search/list surfaces that do not imply executable readiness.
- Link assets to derived capability candidates.

The registry must be append-friendly. Re-importing an asset should create a new
version or import record rather than silently overwriting a previously reviewed
asset.

## Skill Bundle Compatibility

A skill is an instruction asset, not a capability by itself.

PulSeed should preserve existing `SKILL.md` assets from Codex, Claude-style,
OpenClaw, Hermes, or other agents without rewriting them.

Required bundle semantics:

```text
SkillBundle
  SKILL.md
  scripts/
  examples/
  templates/
  assets/
  references/
  metadata/provenance
  compatibility report
```

Rules:

1. Import the directory as a bundle when possible, not only the `SKILL.md` file.
2. Preserve relative references from `SKILL.md` to scripts, examples, templates,
   assets, and references.
3. Keep source provenance and checksum for the root file and referenced bundle
   files.
4. Parse only stable metadata needed for search and routing. The body remains an
   instruction artifact.
5. Do not mutate imported skill text during normal runs.
6. Do not treat a tool name mentioned in a skill as available until it maps to a
   verified PulSeed capability.
7. If a skill references an unknown tool, plugin, shell command, connector, or
   environment, readiness becomes `blocked` for execution and `discoverable` for
   advisory use.
8. A skill can contribute to operation planning only as advisory context unless
   all required capabilities are mapped and pass readiness.

Skill dialect metadata should include:

```text
source_agent: codex | claude | openclaw | hermes | unknown
frontmatter_fields
referenced_tools
referenced_connectors
referenced_paths
referenced_commands
unsupported_references
advisory_safe: boolean
execution_mapping_status
```

The compatibility layer should prefer alias mapping over content rewriting:

```text
foreign tool name -> PulSeed capability -> provider operation
```

If the mapping is ambiguous, the operation planner must ask or fail closed.

## Foreign Plugin Compatibility

Foreign plugins are executable-adjacent assets and require stricter gates than
skills.

Import states:

```text
copied_disabled
quarantined
manifest_compatible
adapter_required
review_required
configured
smoke_verified
native_enabled
blocked
```

Rules:

1. Copy foreign plugin directories unchanged into a disabled or quarantined area.
2. Record manifest summary, source agent, checksum, requested permissions,
   entrypoint, package metadata, and compatibility issues.
3. Never load foreign plugin code directly from quarantine.
4. A manifest-compatible plugin can become executable only through one of:
   - conversion into a native PulSeed plugin,
   - a compatibility adapter that exposes a native PulSeed contract,
   - an MCP or CLI bridge with explicit command and permission policy.
5. Requested `network`, `file_read`, `file_write`, and `shell` permissions must
   be represented as risk and policy inputs.
6. A plugin can be listed as imported or compatible before it is executable, but
   status, docs, demo, and operator/debug surfaces must not call it available for
   use until configured and operation-specific executable verification exists.
   Autonomous use still requires admission and autonomy approval.
7. Trust score starts neutral or conservative. Successful load, successful smoke,
   and successful production reuse are different events and must not be merged.

Native plugin loading remains `PluginLoader`-owned. The Capability Runtime reads
loader state and projects readiness; it should not bypass loader validation.

## Dream Verified Procedural Hints

Dream-backed procedural hints are verifier-gated workflow memory. The current
implementation stores them in `playbook-memory.ts`, but the design contract
should present them as hints rather than skills, plugins, or executable workflow
definitions.

They are not:

- user-authored skills
- generated `SKILL.md` files
- plugins
- execution authority
- proof that future autonomous use is permitted

They can:

- preserve verified workflow shape
- inject compact planning hints
- bias task generation toward proven checks
- track reuse success and failure
- demote or disable after failed reuse
- remain inspectable and editable by the operator

Procedural hint lifecycle:

```text
candidate -> promoted -> active_hint
candidate/promoted -> disabled
promoted + failed_reuse -> candidate
candidate/promoted + stale evidence -> degraded
```

An operation planned from a procedural hint must still pass capability readiness
and the autonomy governor. A verified hint can say "this method worked"; it cannot
say "PulSeed may do this now."

## Capability Graph

The Capability Graph derives capability candidates from assets and runtime
stores.

Inputs:

- Asset Registry
- native plugin loader state
- builtin integration descriptors
- MCP server config
- skill bundle metadata
- Dream procedural hints
- interactive automation provider registry
- notification config and notifier registry
- capability registry
- runtime auth/session/guardrail/backpressure stores
- profile and relationship policy Surface

Outputs:

- capability nodes
- provider edges
- dependency edges
- readiness snapshots
- operation support metadata
- risk and policy metadata

Dependency examples:

```text
send_slack_notification
  requires slack-notifier asset
  requires notifier loaded or compatible adapter
  requires webhook config
  requires notification route admission
  requires network permission
  requires smoke send or production success evidence

run_browser_workflow
  requires interactive automation enabled
  requires provider availability
  requires auth/session state if service is authenticated
  requires browser/session staleness validation
  requires backpressure admission
  requires tool permission policy
```

The graph must support multiple providers for one capability and one provider
backing multiple capabilities.

## MCP Server Compatibility

MCP servers are capability-bearing assets, but an enabled MCP server is not
automatically an executable-verified capability.

MCP readiness should distinguish:

```text
config_imported
config_enabled
server_spawnable
tool_list_available
tool_alias_mapped
auth_or_env_valid
operation_contract_mapped
operation_smoke_verified
operation_production_verified
blocked
```

Rules:

1. Imported MCP servers stay disabled until reviewed.
2. Enabling a server only proves operator selection, not tool availability or
   safe execution.
3. Tool names exposed by an MCP server must map to PulSeed capabilities before
   skills or operation plans can rely on them.
4. Missing env vars, credentials, command binaries, stdio failures, unavailable
   tool lists, or alias conflicts must produce degraded or blocked readiness.
5. Smoke verification should call a low-risk read-only tool where possible
   before read-only operations are projected as executable in status surfaces.
6. A read-only smoke proves server spawn, auth, tool listing, and that specific
   read operation. It does not prove side-effecting operations such as send,
   write, publish, delete, or mutate.
7. Side-effecting MCP tools require operation-specific verification keyed by
   provider, server, tool name, operation kind, payload class, risk class, and
   side-effect profile before they are projected as executable in status
   surfaces.
8. Side-effecting MCP tools require the same autonomy-governor and runtime
   control admission as native tools.

## Readiness Evaluator

Readiness is the answer to "is the execution substrate technically ready for
this specific operation if admission approves?"

It is not the answer to "may PulSeed initiate this operation?" or "may this
operation notify or mutate externally?" Those are admission and autonomy
questions.

Canonical states:

```text
stored
discoverable
loadable
compatible
configured
authenticated
executable_verified
degraded
blocked
```

These states are not a single linear enum for every asset. They are checkpoints
that can be projected per capability and per operation.

The current capability registry uses a coarser compatibility status:

```text
available | missing | requested | acquiring | verification_failed
```

Those values should be treated as legacy registry evidence, not user-facing
execution truth. They can project into readiness as follows:

| Existing status | Readiness projection | Required extra evidence before executable claims |
| --- | --- | --- |
| `missing` | `blocked` or not present | None. It is not executable. |
| `requested` | `blocked` with pending setup/auth/request state | User or provider completion plus config/auth validation. |
| `acquiring` | `degraded` or `blocked` while acquisition runs | Acquisition completion plus verification. |
| `verification_failed` | `blocked` or `degraded` | Fresh successful smoke or production caller-path verification. |
| `available` | At most `configured` or `authenticated` unless stronger evidence exists | Auth/session validity and operation-specific executable verification. |

No implementation may display `available` from the old registry as "ready for
execution" without a readiness snapshot that passes the relevant gates.

Readiness snapshot:

```text
ReadinessSnapshot
  snapshot_id
  capability_id
  operation_kind
  evaluated_at
  state
  passed_gates
  failed_gates
  degraded_gates
  missing_config_refs
  missing_auth_refs
  verification_refs
  evidence_refs
  stale_refs
  safe_user_visible_label
```

Readiness gate definitions:

| Gate | Meaning | Failure behavior |
| --- | --- | --- |
| stored | Asset or runtime descriptor exists. | Not listed as a capability. |
| discoverable | User and agents can find it in list/search surfaces. | Hide from search or mark invalid. |
| loadable | File, manifest, config, or descriptor parses. | Show import error; no execution. |
| compatible | It maps to a known PulSeed contract or adapter path. | Advisory only or review required. |
| configured | Required local config exists and validates. | Ask for setup or mark unavailable. |
| authenticated | Credential/session/auth handoff is valid and scoped. | Request auth, expire stale session, or block. |
| executable_verified | Smoke or production caller-path evidence proves execution works. | Do not render as executable without this evidence. |
| degraded | Usable but limited, stale, partial, or lower-confidence. | Narrow projected behavior and require caution. |
| blocked | Unsafe, unsupported, expired, missing, denied, or conflicting. | Fail closed. |

Every user-facing capability label should be derived from readiness, not from
raw asset presence.

### Admission And Autonomy Are Separate

Readiness deliberately excludes user permission, relationship permission,
quieting policy, privacy policy, notification policy, and runtime-control
authority. Those belong to an admission evaluation and the autonomy governor.

```text
AdmissionPolicyEvaluation
  evaluation_id
  operation_id
  evaluated_at
  actor_ref
  surface_ref
  target_refs
  permission_grant_refs
  relationship_policy_refs
  quieting_policy_refs
  privacy_policy_refs
  runtime_control_refs
  notification_policy_refs
  result: allowed | approval_required | suppressed | prohibited
  rationale
  expires_at
```

Rules:

1. A capability can be `executable_verified` for user-directed execution while
   autonomous initiation remains `approval_required`, `suppressed`, or
   `prohibited`.
2. External notification, external mutation, and conversation initiation must
   pass admission and autonomy checks even when the substrate is executable.
3. Admission results are scoped to actor, surface, target, payload class,
   provider, auth state, and time. They cannot be cached as readiness.
4. Status and demo surfaces must be able to say "ready when you ask" without
   implying "will act on its own."

### Default-Autonomous Internal Metabolism

Some builtin capabilities should be autonomous by default, because the companion
cannot learn where to help, remember what worked, or improve tool use if every
internal memory and evidence operation waits for explicit permission.

The default-autonomous class is narrow:

```text
InternalAutonomyDefault
  capability_family: soil | knowledge | dream | audit | readiness
  operation_kind
  locality: local_only
  side_effect_profile: internal_state_only
  reversibility: reversible | append_only | quarantined
  privacy_ceiling
  scope
  suppression_policy_refs
```

Default-autonomous internal operations may include:

- Soil retrieval, context evaluation, local projection, and local materialization
  into generated cache, snapshot, or review areas that do not publish externally
  and do not directly create, append, update, overwrite, delete, or publish into
  protected targets.
- Knowledge search, recall, consolidation, candidate transfer detection,
  quarantine, and reversible or append-only learning records in internal
  generated stores.
- Dream procedural hint selection, reuse outcome tracking, confidence adjustment,
  demotion, and candidate capture from verified task outcomes.
- Capability readiness observation, verification bookkeeping, audit append, and
  trust/procedural-hint feedback updates.

Rules:

1. Default-autonomous internal metabolism still requires technical readiness.
2. It is allowed by default only when the operation is local, inspectable,
   reversible or append-only, non-interruptive, and has no external side effect.
3. It must not send notifications, publish content, mutate third-party systems,
   operate desktop/browser sessions, call side-effecting MCP tools, or invoke
   foreign plugins without a separate admission and autonomy decision.
4. It must not directly create, append, update, overwrite, delete, or publish
   into protected targets: docs, user-authored memory, hand-maintained
   files, published artifacts, or user-authored skills. Those changes go through
   quarantine, proposal, review, or approval-required flows.
5. Privacy, quieting, tombstone, deletion, workspace boundary, and relationship
   policy can suppress or narrow internal autonomy.
6. Internal autonomy is a growth loop for later capability use: it may improve
   readiness evidence, provider trust, procedural-hint selection, and operation
   planning, but it does not grant external action authority by itself.

## Operation Planner

The Operation Planner turns user instructions, attention outputs, schedule
events, runtime events, or internal proposals into typed `OperationIntent`.

Every semantic decision that affects action must consume typed upstream state or
a structured semantic classification result with confidence, unknown, and
clarification behavior. This includes operation kind, capability selection,
provider routing, target/session/run selection, reply-target selection,
notification decisions, permission inputs, and autonomy inputs.

Freeform human intent must not be classified by keyword lists, regex lists,
string `includes`, title matching, or language-specific phrase tables as the
primary mechanism. Deterministic parsing is allowed only for exact protocol
surfaces such as slash or CLI commands, IDs, file paths, URLs, enum values,
feature flags, and wire/protocol tokens. The execution path must consume typed
operation fields, not raw phrases.

Planner inputs:

- explicit user request
- active Surface
- attention output or urge candidate
- runtime item
- target channel and reply target
- capability graph
- readiness snapshot
- operation history

Planner outputs:

```text
OperationPlan
  plan_id
  intent
  required_capabilities
  candidate_provider_refs
  readiness_snapshots
  admission_requirements
  proposed_execution_path
  required_approvals
  reversible_preparation_steps
  not_allowed_steps
  user_visible_summary
  audit_seed
```

The planner may produce `prepare_only` plans when readiness is incomplete or
autonomy is not granted.

## Autonomy Governor

The Autonomy Governor answers "may PulSeed execute or initiate this operation
now, and at what autonomy level?"

It consumes readiness and admission evaluation. Runtime control remains the
final admission point before execution.

Autonomy levels:

```text
advisory
prepare_only
user_directed_execute
autonomous_low_risk
approval_required
prohibited
```

Decision input:

```text
AutonomyDecisionInput
  operation_plan
  readiness_snapshots
  admission_evaluation
  internal_autonomy_default
  user_directed
  explicit_user_instruction_ref
  active_surface_ref
  relationship_permissions
  quieting_policy
  privacy_context
  runtime_control_state
  companion_state
  auth_state
  guardrail_state
  backpressure_state
  trust_profile
  verification_profile
  recent_feedback
  blast_radius
  reversibility
  external_side_effect
```

Decision output:

```text
AutonomyDecision
  decision_id
  operation_id
  level
  rationale
  allowed_steps
  blocked_steps
  required_user_approval
  required_confirmation_text
  suppression_reason
  audit_refs
  expires_at
```

Rules:

1. User-directed execution can be broader than autonomous execution, but it still
   must pass hard safety, auth, policy, and approval gates.
2. Default-autonomous internal metabolism is allowed for the narrow
   `InternalAutonomyDefault` class. It is how Soil, Knowledge, Dream, audit, and
   readiness loops keep improving without waiting for every internal observation
   or reversible learning step.
3. Autonomous external execution must never infer permission from memory, route config,
   successful past execution, an authenticated session, an enabled MCP server, or
   a notification subscription alone.
4. External mutation, external notification, destructive action, privacy-sensitive
   reads, or high-blast-radius actions default to `approval_required` unless a
   narrower explicit policy grants them.
5. Low-risk autonomous work is limited to reversible, local, inspectable, low
   privacy preparation or observation that admission explicitly allows.
6. If readiness is `degraded`, autonomous initiation must be narrowed or require
   approval.
7. If readiness is `blocked`, the governor returns `prohibited` or
   `prepare_only` with setup/auth guidance.
8. Relationship and quieting policy can suppress an otherwise executable
   operation.
9. Positive feedback can improve trust in a provider, but must not automatically
   widen interruption or external-action authority.
10. Negative feedback must reduce autonomy or require confirmation until corrected.
11. Revocation, correction, tombstone, quieting, suspend, or policy downgrade
    evidence must invalidate cached autonomy decisions.

## Companion Action Projection

The autonomy decision is an internal policy result. It should not be exposed
directly as the normal companion experience.

PulSeed should project the decision into the next best safe action for the
current surface:

```text
AutonomyDecision
  -> CompanionActionProjection
  -> user-visible expression, preparation, approval request, alternative, or silence
```

Projection shape:

```text
CompanionActionProjection
  projection_id
  operation_id
  decision_id
  user_visible_action_kind:
    stay_silent
    suggest
    prepare_draft
    ask_for_approval
    execute_now
    challenge
    refuse_with_alternative
    digest_later
  next_best_safe_action
  brief_reason
  hidden_reason_refs
  surface_expression_policy
  prepared_artifact_refs
  approval_request_ref
  audit_refs
```

Projection rules:

1. `approval_required` usually becomes `prepare_draft`,
   `ask_for_approval`, or both.
2. `prohibited` becomes `refuse_with_alternative`, not a raw policy dump.
3. `suppressed` or quieted work becomes `stay_silent` or `digest_later`.
4. `prepare_only` should create inspectable local preparation when useful.
5. `autonomous_low_risk` may become `execute_now` only when the operation is
   internal or otherwise explicitly admitted for scoped autonomous use.
6. Operator, status, and debug surfaces may show readiness/admission/autonomy
   state. Normal companion UX should express the projected action and a brief
   reason only when useful.
7. Hidden reasons must remain inspectable through audit/debug views without
   turning ordinary chat into a capability-state catalog.

## Permissions, Revocation, And Approval Reuse

Approval is operation-scoped unless the approving surface creates a durable,
typed grant with explicit scope and expiry.

Permission grant shape:

```text
CapabilityPermissionGrant
  grant_id
  actor_scope
  workspace_scope
  surface_scope
  capability_refs
  operation_kinds
  allowed_targets
  risk_ceiling
  side_effect_ceiling
  privacy_ceiling
  created_from_approval_ref
  expires_at
  revoked_at
  superseded_by
  audit_refs
```

Rules:

1. A one-time approval does not become standing autonomous authority.
2. A standing grant must name capability, operation kind, scope, risk ceiling,
   expiry, and revocation path.
3. Grants are invalid when target, workspace, actor, provider, auth state,
   Surface, or payload class changes outside scope.
4. User correction and negative feedback can narrow or revoke grants, but cannot
   silently widen them.
5. Approval reuse must be visible in audit records and status surfaces.

## External Surfaces

External surfaces include Slack, Telegram, Discord, WhatsApp, Signal, email,
webhooks, browser sessions, desktop automation, calendar sources, issue trackers,
and future connectors.

They must be modeled as typed operation surfaces, not as direct side-effect
shortcuts.

Current production entrypoints that must attach to this model:

- Channel adapters and `IngressGateway` receive external messages, evaluate
  inbound access policy, and attach route metadata.
- Gateway dispatch enters chat through `dispatchGatewayChatInput`, which calls
  the registered `processIncomingMessage` port.
- `CrossPlatformChatSessionManager.processIncomingMessage` and
  `ChatRunner.executeIngressMessage` preserve actor, identity, conversation,
  delivery mode, reply target, runtime-control metadata, and goal context.
- `ingress-router` and chat route selection decide typed assist, configure,
  run-spec draft, runtime-control, agent-loop, tool-loop, or adapter routes.
- Runtime-control admission remains a separate gate after ingress route
  selection, even when channel policy marks the sender as approved for inbound
  runtime-control attempts.

For a message or notification surface:

```text
ExternalSurface
  surface_id
  channel
  direction: inbound | outbound | bidirectional
  actor_scope
  conversation_scope
  reply_target_policy
  notification_route_policy
  runtime_control_policy
  auth_state_ref
  quieting_policy_ref
  allowed_operation_kinds
  audit_policy
```

Rules:

1. Inbound message permission is not outbound notification permission.
2. Notification route configuration is not permission to initiate conversation.
3. Runtime event creation is not user notification.
4. Reply target availability is not permission to resume an old session.
5. Authenticated browser/session state is not reusable across workspace, actor,
   service, or staleness boundary mismatches.
6. External action surfaces must preserve audit trails for user-directed and
   autonomous actions.
7. Status, operator, and debug surfaces must label external surfaces by readiness
   plus admission and autonomy state:
   - imported
   - configured
   - needs authentication
   - ready when explicitly requested
   - approved for scoped autonomous use
   - blocked or degraded

## Execution Runtime

Execution should continue through existing PulSeed execution surfaces:

- native tools
- AgentLoop
- DurableLoop task execution
- plugin loader registries
- MCP tools
- interactive automation tools
- notification dispatcher
- runtime control executor

The Capability Runtime should not duplicate those executors. It should provide
the operation plan, readiness snapshot, autonomy decision, companion action
projection, and audit seed that those executors consume.

Execution admission:

```text
OperationPlan + AutonomyDecision + CompanionActionProjection
  -> runtime control admission when execution is selected
  -> executor selection
  -> tool/plugin/MCP/provider call or preparation/approval/silence
  -> verification
  -> audit
  -> trust and procedural-hint feedback
```

An executor must reject an operation when the autonomy decision has expired,
targets changed, readiness became stale, auth changed, guardrails opened, or the
operation payload no longer matches the approved plan.

## Verification And Audit

Every operation that can affect future trust, projected capability state, or
autonomous policy needs verification and audit.

Audit record:

```text
CapabilityAuditRecord
  audit_id
  operation_id
  user_directed
  initiated_by
  source_surface
  capability_refs
  provider_refs
  readiness_snapshot_refs
  autonomy_decision_ref
  approval_refs
  execution_refs
  verification_refs
  result
  side_effect_summary
  user_visible_effect
  follow_up_policy_effect
  created_at
```

Verification classes:

```text
parse_validation
manifest_validation
configuration_validation
auth_probe
permission_probe
smoke_execution
production_caller_path
post_execution_verification
reuse_outcome
operator_review
```

Verification references must be operation-specific:

```text
CapabilityVerificationRef
  verification_id
  provider_ref
  asset_ref
  capability_id
  operation_kind
  tool_name
  payload_class
  risk_class
  side_effect_profile
  verification_class
  result
  evidence_ref
  expires_at
```

A `permission_probe` verifies a permission or policy source can be queried. It
does not replace admission evaluation for a concrete operation.

Trust and readiness updates must distinguish:

- imported successfully
- parsed successfully
- loaded successfully
- configured successfully
- smoke verified
- production succeeded
- production failed
- user corrected or revoked

These are different evidence events and must not collapse into one success
counter.

## Product Truthfulness, Status, And Operator Surfaces

This section is not a capability-catalog design for normal companion UX. It is a
truthfulness contract for README, docs, demos, status views, TUI diagnostics,
operator views, and debug surfaces.

Normal companion UX should prefer the next best safe action over exposing raw
capability state. For example, say "I can prepare the draft and ask before
sending" instead of foregrounding `approval_required`.

Docs, demos, status, and operator/debug surfaces must not overstate
capability.

Allowed labels should be derived from readiness:

| Readiness | Safe label |
| --- | --- |
| stored/discoverable | Imported or available for review |
| loadable/compatible | Compatible with setup required |
| configured | Configured, not yet verified |
| authenticated | Authenticated, verification needed |
| executable_verified | Execution substrate verified |
| degraded | Limited availability |
| blocked | Blocked with reason |

Autonomy-facing labels must add admission and autonomy state:

| Readiness plus admission/autonomy | Safe label |
| --- | --- |
| `executable_verified` plus user-directed admission allowed | Ready when you ask |
| `executable_verified` plus scoped autonomous admission allowed | Approved for scoped autonomous use |
| `executable_verified` plus approval required | Ready after approval |
| `executable_verified` plus suppressed or prohibited | Ready technically, blocked by policy |

README, demos, status, TUI diagnostics, and operator/debug surfaces may show
configured or imported capability only if they are honest about state. A demo or
operator surface that implies PulSeed can autonomously act must include evidence
that:

- the capability is executable-verified,
- the operation passes autonomy governor policy,
- the runtime action is inspectable and interruptible,
- external side effects are approved or within explicit low-risk policy,
- failure modes are visible.

## Implementation Boundaries

This design should be implemented through focused, reviewable changes rather
than one large integration.

Recommended order:

1. Design and implement Asset Registry records in `src/runtime/assets/` for
   skill bundles, foreign plugins, MCP imports, native plugins, builtins, Soil
   surfaces, Knowledge surfaces, and Dream procedural hints.
2. Preserve skill bundles during import, including referenced scripts, examples,
   templates, assets, and provenance/checksum metadata in
   `src/interface/cli/commands/setup/import/` and
   `src/runtime/skills/skill-registry.ts`.
3. Extend foreign plugin compatibility reports with checksum, source provenance,
   adapter requirements, execution blockers, and smoke requirements.
4. Build Capability Graph projection from asset registry, plugin loader state,
   MCP config, interactive automation registry, notifier config, Soil/Knowledge
   stores, and procedural hints.
5. Implement Readiness Evaluator snapshots and status/operator labels, keeping
   technical readiness separate from admission and autonomy.
6. Add Operation Planner typed contracts for user-directed and autonomous
   capability use.
7. Implement default-autonomous internal metabolism policy for Soil, Knowledge,
   Dream, audit, and readiness loops.
8. Implement Admission Policy Evaluation and Autonomy Governor decisions, then
   integrate them with runtime control admission.
9. Add `CompanionActionProjection` so normal chat and GUI surfaces convert
   policy outcomes into the next best safe action.
10. Integrate external surfaces with typed trigger, reply target, notification,
   auth, policy, and audit semantics.
11. Add verification and audit records for capability execution, smoke tests,
   production caller-path use, and trust/procedural-hint feedback.
12. Update README, docs, demos, status, TUI diagnostics, and operator/debug
    surfaces to project only readiness-derived capability state plus explicit
    admission/autonomy state. Normal chat and GUI companion UX should instead
    project the next best safe action.

Prerequisite implementation decisions before runtime behavior changes:

| Decision | Required design outcome | Owner surface |
| --- | --- | --- |
| Readiness persistence | Store durable verification/audit events, compute snapshots on demand, and cache snapshots only with invalidation by config, auth, provider, target, payload class, and policy epoch. | `src/runtime/store/`, new readiness evaluator |
| Legacy status aliases | Keep current `CapabilityStatus` as import/registry evidence only. It never renders executable or autonomous labels directly. | `src/platform/observation/types/capability.ts` |
| Skill checksums | Record a per-file manifest plus root bundle checksum so relative assets can be verified without rewriting upstream files. | setup import and skill registry |
| Provider smoke contracts | Define per-provider-family smoke contracts keyed by operation kind, payload class, risk class, and side-effect profile. | verification/audit store |
| Internal autonomy default | Define the exact local, reversible, append-only, non-interruptive operations that Soil, Knowledge, Dream, audit, and readiness may run without explicit user prompting. | autonomy governor |
| Autonomy policy scope | Use global defaults plus workspace, relationship, surface, and provider overrides. The most restrictive applicable policy wins. | autonomy governor |
| Companion action projection | Map autonomy decisions to surface-specific actions such as prepare draft, ask for approval, refuse with alternative, digest later, or stay silent. | chat/TUI/GUI expression surfaces |
| Foreign-plugin review artifact | Represent operator review as a durable `CompatibilityReviewRecord`, not as a loader flag or trust score. | foreign plugin bridge |

## Test Requirements

Follow-up implementation must include production caller-path tests, not only
unit tests over precomputed lower-level inputs.

Required cases:

- Import a skill bundle with relative `scripts/`, `examples/`, and `templates`;
  verify search/list/show preserves the bundle and does not rewrite it.
- A skill referencing an unknown tool is discoverable/advisory but not rendered
  as executable in status or docs.
- A foreign plugin with compatible manifest but network permission is copied
  disabled/quarantined and not loaded by `PluginLoader`.
- A native plugin that loads but lacks config is not rendered as executable.
- A notifier route configured without a successful send is not labeled
  executable-verified.
- A Slack-like external route can be user-directed after verification but still
  requires approval or explicit policy for autonomous notification.
- A capability with `executable_verified` readiness can run when explicitly
  requested, while the same provider and payload class is suppressed or requires
  approval for autonomous notification or initiation.
- Gateway and chat caller-path tests must run through the real ingress shape:
  channel adapter or `IngressGateway` policy where relevant,
  `dispatchGatewayChatInput`, `processIncomingMessage`,
  `ChatRunner.executeIngressMessage`, `ingress-router`, and runtime-control
  admission. These tests must prove inbound access, outbound notification
  permission, reply target, notification route, and runtime-control authority
  remain separate.
- Freeform operation planning and route selection tests must include
  paraphrases, multilingual wording, ambiguous input that returns unknown or
  clarification, and stale or previous-target rejection. They must fail if the
  implementation relies on keyword, regex, `includes`, or title matching for
  freeform intent.
- Runtime event creation alone does not dispatch a user notification.
- A verified Dream procedural hint can influence task generation as a hint but
  cannot create or overwrite a `SKILL.md` file.
- An imported MCP server remains non-executable until enabled, tool-listed,
  alias-mapped, auth/config-validated, operation-contract mapped, and
  operation-specific verified.
- A read-only MCP smoke does not render side-effecting MCP operations such as
  send, write, publish, delete, or mutate as executable.
- Builtin `available` entries, Soil surfaces, and KnowledgeManager/search or
  transfer availability do not render executable or autonomous labels without
  readiness snapshots and operation-specific verification.
- Soil retrieval/projection, Knowledge recall/quarantine, Dream procedural
  hinting, audit append, and readiness observation can receive default
  `autonomous_low_risk` decisions when they are local, reversible or append-only,
  non-interruptive, and have no external side effects.
- Soil local materialization or Knowledge learning that targets docs,
  user-authored memory, hand-maintained files, published artifacts, or
  user-authored skills must return quarantine, proposal, review, or
  approval-required, not
  `autonomous_low_risk`.
- The same internal default does not permit Soil publish/open to external
  targets, Knowledge cross-scope auto-apply, deletion, notification, browser or
  desktop operation, side-effecting MCP tools, or foreign plugin execution.
- A browser session that is authenticated but stale, mismatched, expired, or
  superseded fails closed rather than being reused.
- A one-time approval permits only the approved operation and cannot be reused as
  standing autonomous authority without a scoped durable grant.
- Autonomy governor returns `prepare_only`, `approval_required`, or `prohibited`
  for external, irreversible, privacy-sensitive, degraded, or blocked operations.
- `CompanionActionProjection` maps `approval_required` to `prepare_draft` or
  `ask_for_approval`, `prohibited` to `refuse_with_alternative`, and suppressed
  or quieted work to `stay_silent` or `digest_later`.
- Status, docs, demos, TUI diagnostics, and operator/debug helpers derive labels
  from readiness snapshots plus explicit admission/autonomy state rather than raw
  asset presence.
- Normal chat and GUI companion UX present the next best safe action, not a
  capability catalog or raw readiness/admission/autonomy dump.
