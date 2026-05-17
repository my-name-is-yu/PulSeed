# Long-run Evaluation Lab

> Status: current developer/operator quality infrastructure. This is not a
> user-facing autonomy feature and should not be described as ordinary user
> behavior.
> Doc status: active_design_contract
> Grounding use: design_context

The Long-run Evaluation Lab is PulSeed's local regression discovery runtime for
companion-quality behavior. It runs deterministic fake-time scenarios without
provider keys, real network access, Telegram, or external services. The lab is
under `tests/eval-lab` and runs with:

```sh
npm run test:eval-lab
```

## What It Exercises

The lab is intentionally broader than a single slow test. Scenario definitions
cover multi-turn chat, corrected memory reuse, stale memory rejection, schedule
wakes, daemon-style approval restart, duplicate delivery prevention after
replay, tool/capability failure recovery, quiet-mode holds, overreach feedback,
missed-help detection, stale action binding rejection, and Telegram projection
consistency.

The runner uses fake controls for user turns, provider output, Telegram/gateway
identity, workspace/filesystem roots, fake time, blocked network, and plugin or
capability availability. It still crosses production caller paths such as
`ChatRunner.execute`, `ScheduleEngine.tick`, `ApprovalBroker`,
`OutboxStore.append`, `ToolExecutor.execute`, `InteractionAuthorityStore`, and
`RuntimeEventLogStore.rebuildProjections`.

## Artifacts

Each scenario writes a typed `EvalRunArtifact` to
`tmp/eval-lab/<scenario-id>/run-artifact.json`. The artifact includes scenario
id, seed, fake clock, runtime event refs, RuntimeGraph refs, normal and operator
projections, transcript, replay summary, metrics, failures, and a reproduction
command.

When a scenario fails or a metric threshold blocks the run, failure material is
written under `tmp/eval-failures/<scenario-id>/`:

- `scenario.json`
- `normal-projection.json`
- `operator-projection.json`
- `event-log-replay-trace.json`
- `transcript.json`
- `metrics.json`
- `reproduction-command.txt`

These files are debugging artifacts only. They are not authoritative runtime
state.

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

Model-mediated judgments are non-authoritative. Scenario pass/fail decisions
come from deterministic assertions, typed memory/correction state, authority
decisions, side-effect dedupe records, and Runtime Event Log replay summaries.

## Adding A Scenario

Add a scenario case in `tests/eval-lab/scenarios.ts` with:

- a stable `scenario_id` and `seed`
- one or more required coverage tags
- fake controls for local provider, gateway, workspace, clock, network, and
  capability state
- deterministic steps using the DSL
- metric thresholds only when the scenario needs stricter local behavior

If a new step needs a production boundary that the runner does not currently
cross, extend `tests/eval-lab/runner.ts` instead of adding fake-only assertions.
The scenario should write enough surface and operator projection evidence for a
failure to be diagnosed from the artifact directory.

## PR Blocking Rules

A PR is blocked when:

- `npm run test:eval-lab` fails
- a scenario only proves mocked lower-level helpers and no production caller
  path
- replay does not use `RuntimeEventLogStore.rebuildProjections`
- failure artifacts are missing normal projection, operator projection,
  event-log/replay trace, transcript, metrics, or reproduction command
- any thresholded metric fails
- network, real Telegram, provider keys, or external services are required
