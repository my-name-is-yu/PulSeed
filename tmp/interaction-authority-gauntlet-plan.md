# Interaction Authority Evaluation Lab Plan

## Lane Placement

| Lane | Use |
| --- | --- |
| `tests/product-gauntlet` | Reusable product-wide gauntlet for interaction authority scenarios with temp `PULSEED_HOME`, isolated control DB/runtime root, fake transport/provider/clock, expected authority decisions, expected normal projection, operator/debug evidence, safety invariants, and replay/restart invariants. |
| `tests/harness/product-gauntlet-runner.ts` | Shared runner that captures authority decisions, normal projections, operator/debug evidence, DB summaries, replay summaries, and writes `tmp/eval-failures/<scenario-id>/` only on failure or local debug mode. |
| `npm run test:product-gauntlet` | Dedicated package script. The suite remains real-network/real-LLM/real-secret free. |
| `tests/contracts` | Existing product-completion contracts remain for broad redaction and personal-agent path coverage. |
| `tests/golden-traces` | Existing stale approval/runtime-control/schedule fixture coverage remains; new authority lab can reference but does not need huge fixture churn for every scenario. |
| `tests/replay` | Existing restart/replay coverage remains; gauntlet adds direct restart/dedupe scenarios over peer delivery, runtime outbox, and memory correction. |

## Scenario Catalog

| Scenario | Production boundary | Expected authority decision | Expected visible projection | Safety invariant |
| --- | --- | --- | --- | --- |
| `telegram_peer_delivery_succeeds` | resident peer initiative -> outbound conversation -> fake Telegram transport | `allowed`, `can_send=true`, `can_notify=true`, target/channel/delivery/transport refs present | normal projection raw refs false; feedback affordance present | one PeerDeliveryRecord and one send only |
| `telegram_callback_stale_wrong_message_rejected` | Telegram adapter callback -> PeerDeliveryRecord match -> feedback store | `fail_closed`, `stale_target_rejected=true`, `can_execute=false` | callback ack only | no feedback effect and no task/runtime mutation |
| `telegram_callback_failure_offset_progress` | Telegram poll loop over callback failure then later update | callback failure health recorded; offset advances | none beyond ack/error health | later updates continue after failure |
| `digest_only_peer_initiative_held` | resident peer initiative threshold/digest path | `held` or `prepare_only`, `can_hold=true`, `can_send=false`, `can_notify=false`, `suppressed=true` | normal projection redacts raw policy | transport not called |
| `old_approval_cannot_execute` | ToolExecutor approval request -> PermissionWaitPlanStore resume -> tool.call boundary | success records `allowed`; stale args/conversation and expired approvals record `fail_closed`, `requires_approval=true`, `stale_target_rejected=true`, `approval_ref`, `target_binding_ref` | user-facing denial without raw plan internals | stale/wrong conversation/args/expired approval cannot execute tool |
| `quiet_mode_suppresses_before_transport` | NotificationDispatcher DND/cooldown path | `suppressed`, `can_suppress=true`, `can_notify=false` | no raw policy refs | transport send not called |
| `memory_correction_later_recall_projection` | runUserMemoryOperation -> KnowledgeManager recall after StateManager restart -> inspectUserMemory normal projection | `allowed` correction and `memory_withheld=true` later stale use | normal projection omits stale memory and raw refs; diagnostic history remains visible | old corrected/forgotten/retracted memory is absent from later recall and normal projection |
| `tool_executor_denial_no_direct_fallback` | ToolExecutor missing/denied tool path | `fail_closed`/personal-agent action_outcome non-executed | normal tool failure only | adapter/tool.call is never invoked |
| `restart_replay_no_duplicate_side_effects` | Peer delivery, runtime outbox, and memory correction after store/runtime recreation | same durable input reuses prior authority/dedupe/correction state | stable projection | same durable input not resent/enqueued/duplicated; distinct idempotency key can send/enqueue |
| `normal_projection_redacts_internals` | ChatRunner `/status`, `SharedManagerTuiChatSurface` `/status`, CLI current/focused status/report | projection evidence is caller-path output, not a hand-built projection object | raw trace/run/session/evidence/policy/capability/memory refs hidden from normal outputs | operator/debug remains explicit; normal payloads hide raw refs |
| `runtime_control_schedule_authority_boundaries` | RuntimeControlService pause_run and ScheduleEngine cron wake | PersonalAgentRuntimeStore projection evidence before executor/data/model side effects | operator/debug trace can inspect SituationFrame/InterventionDecision | runtime-control and schedule remain fail-closed/projection-evidence-backed before mutation |

## Failure Artifact Contract

On failure or `PULSEED_PRODUCT_GAUNTLET_DEBUG=1`, the runner writes:

- `tmp/eval-failures/<scenario-id>/scenario.json`
- `tmp/eval-failures/<scenario-id>/authority-decisions.json`
- `tmp/eval-failures/<scenario-id>/normal-projection.json`
- `tmp/eval-failures/<scenario-id>/operator-debug-evidence.json`
- `tmp/eval-failures/<scenario-id>/db-summary.json`
- `tmp/eval-failures/<scenario-id>/replay-summary.json`
- `tmp/eval-failures/<scenario-id>/candidate-fix-plan.md`

The candidate fix plan lists the failed invariant, likely owner file, and next file to inspect. The files are not empty templates: they include the scenario root, expected invariants, recorded authority decisions, normal projection, operator/debug evidence, DB summary, and replay summary captured before the failure. CI does not need to write artifacts for passing scenarios.
