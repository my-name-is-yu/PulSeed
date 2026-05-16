# Interaction Authority Contract Matrix

Generated from `/Users/yuyoshimuta/PulSeed` at `c844361f9f289cbb8f077d341335cfc534847f4d`.

## Existing Contract Roles

| Contract | Current role | Mutation owner | Projection-only surfaces |
| --- | --- | --- | --- |
| `ExecutionAuthorityDecision` | Cross-cutting authority snapshot for host/tool/admission/autonomy/resident/outbound/notification/callback/approval-resume/memory-correction decisions. It carries the shared interaction authority vocabulary and durable evidence refs. | Caller that owns the side effect or delivery boundary. | Normal surfaces may receive only redacted summaries derived from it. |
| `InterventionDecision` | Personal-agent decision: allow, hold, block, suppress, confirm_required. | PersonalAgentRuntimeStore records the durable trace. | `PersonalAgentNormalSurfaceProjection` converts it to normal user text. |
| `SituationFrame` | Typed evidence input for a caller path, including current/stale/withheld refs. | PersonalAgentRuntimeStore. | Normal surfaces see `normal_surface_trace_visible=false`. |
| `InitiativeEvent` | Append-only event sequence for signal, policy decision, action request/outcome, memory update, resume. | PersonalAgentRuntimeStore. | Normal surfaces see summaries, not raw event ids. |
| `RuntimeGraph` | Durable lineage/source-of-truth graph for runtime entities and reply targets. | RuntimeGraph owners in state stores and PersonalAgentRuntimeStore. | Normal surfaces get projections; operator/debug surfaces can inspect graph refs. |
| `PersonalAgentNormalSurfaceProjection` | Redacted normal-user projection with raw trace/ref/policy/capability visibility forced false. | Projection owner only; it never mutates runtime state. | Chat/gateway/TUI-adjacent/status/report normal surfaces. |
| `OutboundConversation` | Typed peer initiative outbound message/target/receipt. | Gateway outbound conversation port owns transport send. | Payload text/actions only; raw policy internals must stay out. |
| `PeerInitiativeStore` | Durable candidate, delivery, prepared artifact, feedback projection records. | Peer initiative runtime owner. | Diagnostics expose records; normal payloads use rendered message/projection only. |

## Unified Authority Vocabulary

The kernel vocabulary is intentionally split so one grant cannot imply another:

| Field | Meaning |
| --- | --- |
| `can_prepare` | PulSeed may assemble, draft, inspect, or stage local reversible context. It does not imply execution, send, notify, or mutation. |
| `can_execute` | PulSeed may perform the admitted mutation/tool/runtime operation. It does not imply user-visible send/notify. |
| `can_send` | PulSeed may send this exact outbound payload to this exact target binding/channel policy. |
| `can_notify` | PulSeed may interrupt or notify; stronger than `can_send` because quieting/DND/budget policy must pass. |
| `can_ask` | PulSeed may ask the user for confirmation/clarification without executing the underlying operation. |
| `can_hold` | PulSeed may keep the candidate durably without delivery/mutation. |
| `can_suppress` | PulSeed must stay quiet for this candidate and record suppression before transport. |
| `requires_approval` | The prepared action needs a fresh approval bound to exact conversation/target/args/policy. |
| `fail_closed` | The decision blocks side effects. The caller must not fall through to an adapter, stale target, or fallback mutation. |
| `stale_target_rejected` | A current target, approval, message, delivery, channel policy, or args binding did not match. |
| `suppressed` | The authority layer intentionally blocked user-visible send/notify before transport. |
| `memory_withheld` | Corrected/retracted/forgotten/sensitive memory was withheld from action or normal surface projection. |

## Mutation Owners vs Projection Owners

| Surface/path | Authority owner | Mutation owner | Projection boundary |
| --- | --- | --- | --- |
| Chat ordinary turn | ChatRunner + personal-agent trace | ChatRunner/tool/runtime owner | Normal chat output; no raw trace refs. |
| TUI ordinary turn | Shared chat/runtime-control authority | TUI display/approval UI only | TUI is projection-only unless explicit command invokes runtime owner. |
| Gateway inbound chat | Channel policy + ChatRunner trace | ChatRunner/gateway display transport | Non-TUI display policy and normal projection. |
| Telegram peer outbound | Interaction authority + PeerInitiativeStore + Telegram outbound port | Telegram port sends only after authority row | Message text/buttons only; no policy/evidence refs. |
| Telegram callback feedback | Interaction authority + PeerDeliveryRecord | FeedbackIngestionStore and PeerInitiativeStore | Callback ack only; stale/wrong callback mutates nothing. |
| Notification dispatch | Interaction authority + personal-agent trace | NotificationDispatcher channel/plugin send | Suppressed/held decisions are not normal raw policy output. |
| Approval resume | ToolExecutor approval boundary + PermissionWaitPlanStore + InteractionAuthorityStore | Tool.call only after exact canonical resume match | Approval prompt summary; diagnostic store for exact refs. |
| Runtime-control | RuntimeControlService + RuntimeOperationStore + PersonalAgentRuntimeStore | RuntimeOperationStore / service action | Normal summary vs operator/debug diagnostic split. Uses personal-agent projection evidence rather than InteractionAuthorityStore because the mutation owner is the runtime operation store, not a transport sender. |
| Memory correction | runUserMemoryOperation + MemoryCorrectionLedger / KnowledgeManager + PersonalAgentRuntimeStore + InteractionAuthorityStore | Correction operation owner | User-facing memory inspect projection redacts raw/sensitive refs; operator/debug history remains explicit. |
| ToolExecutor | Host policy + permission manager + personal-agent trace + approval-resume authority | Tool.call only after admission | Tool results surfaced by caller; action_outcome remains internal evidence. |
| Schedule/daemon resident | ScheduleEngine/Resident attention+operation boundary + PersonalAgentRuntimeStore | Schedule or resident action owner | Reports/diagnostics via explicit surfaces. Schedule uses personal-agent projection evidence because it owns durable schedule/history state rather than a user transport. |

## Implemented Contract Extension

`ExecutionAuthorityDecision` is now the durable interaction authority kernel for the implemented caller paths. The schema adds:

- `can_notify`, `can_ask`, `can_hold`, `can_suppress`
- `requires_approval`, `suppressed`, `stale_target_rejected`, `memory_withheld`
- `surface`, `surface_class`
- `target_binding_ref`, `channel_policy_ref`, `delivery_ref`, `transport_message_ref`
- `feedback_ref`, `approval_ref`, `quieting_ref`, `normal_surface_projection_ref`

The production caller paths connected in this slice record or project authority before direct Telegram transport, peer feedback mutation, notification suppression/send, ToolExecutor approval resume, ToolExecutor admission fallback handling, memory-correction save/recall/inspect, runtime-control mutation, schedule cron/probe execution, and runtime outbox enqueue. Normal surfaces may render only redacted projections. Operator/debug surfaces may inspect authority rows, personal-agent traces, RuntimeGraph evidence, or product-gauntlet failure artifacts explicitly.

## Production-Path Evidence Requirements

- Approval resume completion evidence must come from `ToolExecutor.requestPermissionApproval()` reaching `PermissionWaitPlanStore.resumeApproved()` and recording an approval `ExecutionAuthorityDecision`; direct `PermissionWaitPlanStore` checks alone are insufficient.
- Memory correction completion evidence must come from `runUserMemoryOperation()` and later `KnowledgeManager` recall / `inspectUserMemory()` projection. Direct `projectMemoryCorrectionAuthority()` tests alone are insufficient.
- Normal-surface redaction evidence must pass through ChatRunner `/status`, TUI-adjacent `SharedManagerTuiChatSurface`, and CLI status/report production callers. Hand-assembled `PersonalAgentNormalSurfaceProjection` objects are not accepted as product-wide proof.
- Runtime-control and schedule remain PersonalAgentRuntimeStore projection-evidence paths unless they are sending to a user transport. Their completion evidence is a durable SituationFrame/InitiativeEvent/InterventionDecision before the RuntimeControl executor or schedule side effects.
- Telegram is the current peer initiative delivery implementation. Non-Telegram peer initiative surfaces remain contract-only future work.
