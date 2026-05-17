# Long-run Evaluation Lab

> Status: Product design boundary document. This page describes current operator/developer quality infrastructure and does not claim additional user-facing autonomy.

The Long-run Evaluation Lab is a deterministic local test lane for companion-quality
regression discovery. It sits beside the product gauntlet and replay lanes: the lab
combines multi-turn scenario scripts, fake time, restart/replay, memory correction,
approval, gateway/Telegram projection, proactivity calibration, and failure-artifact
export in one reusable scenario runtime.

Run it with:

```bash
npm run test:eval-lab
```

The lane must not use real providers, real Telegram, real network, real API keys, or
external services. Scenario steps use fake user turns, `ScriptedLlm`, `ScriptedToolRunner`,
isolated state roots, a no-network guard, and `HarnessClock`. Runtime evidence is still
connected to current production owners: `PersonalAgentRuntimeStore`, `InteractionAuthorityStore`,
`PermissionWaitPlanStore`, memory correction operations, schedule wake trace recording,
and `RuntimeEventLogStore.rebuildProjections()`.

## Adding Scenarios

Add new cases in `tests/eval-lab/scenarios.ts`. A scenario declares:

- `scenario_id`, `seed`, title, coverage labels, and fake start time
- ordered DSL steps such as `fake_user_turn`, `fake_provider_model`,
  `fake_telegram_gateway`, `fake_filesystem_workspace`, `fake_clock_advance`,
  `fake_network`, `fake_plugin_capability`, `daemon_restart`, `event_log_replay`,
  `schedule_wake`, `approval_request`, `approval_response`, `memory_correction`,
  `feedback`, `quiet_proactivity_control`, and `stale_action_binding`
- expected runtime event types, RuntimeGraph edge kinds, metric thresholds, and any
  intentionally detected quality failures

Each run writes a typed `EvalRunArtifact` under `tmp/eval-lab/<scenario-id>/run-artifact.json`.
The artifact includes scenario id, seed, fake clock, runtime event refs, RuntimeGraph refs,
surface projections, operator projections, transcript, replay summary, metrics, failures,
and a minimal reproduction command.

## Metrics

The lab computes and thresholds:

- `overreach_rate`
- `missed_help_rate`
- `duplicate_side_effect_rate`
- `stale_action_rejection_rate`
- `memory_retrieval_hit_rate`
- `corrected_memory_reuse_rate`
- `sensitive_leak_rate`
- `approval_bypass_rate`
- `replay_equivalence_rate`
- `scenario_pass_rate`

Model-mediated judgments are non-authoritative. A scenario may include scripted model output
as transcript material, but pass/fail decisions come from deterministic typed facts:
runtime events, authority decisions, memory recall results, replay equivalence, projection
contents, and metric thresholds.

## PR Blocking Rules

A PR is blocked when `npm run test:eval-lab` fails, when a scenario omits its required
runtime event or RuntimeGraph edge, when a metric threshold is missed, when replay does
not use `RuntimeEventLogStore.rebuildProjections()`, or when a scenario depends on real
network/provider/Telegram state.

On failure the lab writes `tmp/eval-failures/<scenario-id>/` with normal projection,
operator projection, event-log/replay trace, transcript, metrics, failures, and a reproduction
command. These artifacts are operator/developer debugging evidence; they are not normal
user-facing behavior.
