# Interaction Authority Evaluation Lab Plan

## Lane Placement

| Lane | Use |
| --- | --- |
| `tests/product-gauntlet` | New reusable product gauntlet for interaction authority scenarios with temp `PULSEED_HOME`, fake transport/provider, fixture DB, expected authority decision, expected visible projection, and safety invariant. |
| `tests/harness/product-gauntlet-runner.ts` | Shared runner that installs no-network guard, captures authority decisions/projections/DB summaries, and writes `tmp/eval-failures/<scenario-id>/` only on failure or local debug mode. |
| `npm run test:product-gauntlet` | Dedicated package script. The suite remains real-network/real-LLM/real-secret free. |
| `tests/contracts` | Existing product-completion contracts remain for broad redaction and personal-agent path coverage. |
| `tests/golden-traces` | Existing stale approval/runtime-control/schedule fixture coverage remains; new authority lab can reference but does not need huge fixture churn for every scenario. |
| `tests/replay` | Existing restart/replay coverage remains; gauntlet adds one direct restart/dedupe scenario over peer delivery/authority rows. |

## Scenario Catalog

| Scenario | Production boundary | Expected authority decision | Expected visible projection | Safety invariant |
| --- | --- | --- | --- | --- |
| `telegram_peer_delivery_succeeds` | resident peer initiative -> outbound conversation -> fake Telegram transport | `allowed`, `can_send=true`, `can_notify=true`, target/channel/delivery/transport refs present | normal projection raw refs false; feedback affordance present | one PeerDeliveryRecord and one send only |
| `telegram_callback_stale_wrong_message_rejected` | Telegram adapter callback -> PeerDeliveryRecord match -> feedback store | `fail_closed`, `stale_target_rejected=true`, `can_execute=false` | callback ack only | no feedback effect and no task/runtime mutation |
| `telegram_callback_failure_offset_progress` | Telegram poll loop over callback failure then later update | callback failure health recorded; offset advances | none beyond ack/error health | later updates continue after failure |
| `digest_only_peer_initiative_held` | resident peer initiative threshold/digest path | `held` or `prepare_only`, `can_hold=true`, `can_send=false`, `can_notify=false`, `suppressed=true` | normal projection redacts raw policy | transport not called |
| `old_approval_cannot_execute` | ToolExecutor / PermissionWaitPlanStore resume | `fail_closed`, `requires_approval=true` or approval mismatch/stale target | user-facing denial without raw plan internals | stale/wrong conversation/args approval cannot execute tool |
| `quiet_mode_suppresses_before_transport` | NotificationDispatcher DND/cooldown path | `suppressed`, `can_suppress=true`, `can_notify=false` | no raw policy refs | transport send not called |
| `memory_correction_later_recall_projection` | user memory operation -> KnowledgeManager recall -> normal/user diagnostic projection | `allowed` correction and `memory_withheld=true` later stale use | normal projection omits stale memory; diagnostic reason visible | old corrected/forgotten/retracted memory is absent from chat/gateway/proactive/reflection planning inputs |
| `tool_executor_denial_no_direct_fallback` | ToolExecutor missing/denied tool path | `fail_closed`/personal-agent action_outcome non-executed | normal tool failure only | adapter/tool.call is never invoked |
| `restart_replay_no_duplicate_side_effects` | Peer delivery claim/retry over same durable input | second run sees delivered/claimed record | stable projection | same durable input not resent; distinct idempotency key can send |
| `normal_projection_redacts_internals` | chat/gateway/TUI-adjacent/status/report projections | `normal_surface_projection_ref` present and surface class normal | `raw_trace_visible=false`, `raw_refs_visible=false`, `internal_policy_refs_visible=false` | operator/debug remains explicit; normal payloads hide raw refs |

## Failure Artifact Contract

On failure or `PULSEED_PRODUCT_GAUNTLET_DEBUG=1`, the runner writes:

- `tmp/eval-failures/<scenario-id>/scenario.json`
- `tmp/eval-failures/<scenario-id>/authority-decision.json`
- `tmp/eval-failures/<scenario-id>/visible-projection.json`
- `tmp/eval-failures/<scenario-id>/db-summary.json`
- `tmp/eval-failures/<scenario-id>/candidate-fix-plan.md`

The candidate fix plan lists the failed invariant, likely owner file, and next file to inspect. CI does not need to write artifacts for passing scenarios.
