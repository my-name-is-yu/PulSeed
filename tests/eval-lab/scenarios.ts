import { EvalScenarioSchema, type EvalScenario, type EvalStep } from "./types.js";

const START = "2026-05-17T00:00:00.000Z";

const defaultThresholds = [
  { metric: "overreach_rate" as const, max: 0 },
  { metric: "missed_help_rate" as const, max: 0 },
  { metric: "duplicate_side_effect_rate" as const, max: 0 },
  { metric: "sensitive_leak_rate" as const, max: 0 },
  { metric: "approval_bypass_rate" as const, max: 0 },
  { metric: "replay_equivalence_rate" as const, min: 1 },
  { metric: "scenario_pass_rate" as const, min: 1 },
];

function scenario(input: Omit<EvalScenario, "schema_version" | "fake_controls" | "provider_script" | "metric_thresholds"> & {
  provider_responses?: string[];
}): EvalScenario {
  const { provider_responses, ...scenarioInput } = input;
  return EvalScenarioSchema.parse({
    schema_version: "pulseed.eval-lab.scenario/v1",
    fake_controls: {
      clock_start: START,
      provider_model: "scripted-local-eval-model",
      telegram_gateway: {
        platform: "telegram",
        conversation_id: `telegram:${input.scenario_id}`,
        user_id: "operator",
      },
      filesystem_workspace: `workspace:${input.scenario_id}`,
      network: { blocked: true },
      plugin_capability: {
        capability_id: `capability:${input.scenario_id}`,
        available: true,
      },
    },
    provider_script: (provider_responses ?? [])
      .map((response_text, index) => ({
        request_phase: `turn-${index + 1}`,
        response_text,
      })),
    metric_thresholds: defaultThresholds,
    ...scenarioInput,
  });
}

function replay(): EvalStep {
  return { kind: "event_log_replay" };
}

export const evalLabScenarios: EvalScenario[] = [
  scenario({
    scenario_id: "multi-turn-chat-memory-use",
    seed: "eval-lab-seed-001",
    title: "Multi-turn chat with memory use",
    description: "A gateway chat turn uses a seeded local memory across two turns.",
    coverage: ["multi_turn_chat_with_memory_use"],
    provider_responses: [
      "I remember your launch checklist preference and will keep the reply short.",
      "Continuing from that checklist preference, the next step is verification.",
    ],
    steps: [
      { kind: "memory_seed", key: "launch-checklist-style", value: "The user prefers short launch checklists.", memory_type: "preference" },
      { kind: "user_turn", input: "Help me with the launch note.", expected_assistant: "short", memory_refs: ["launch-checklist-style"] },
      { kind: "user_turn", input: "What should I do next?", expected_assistant: "verification", memory_refs: ["launch-checklist-style"] },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "corrected-memory-reuse",
    seed: "eval-lab-seed-002",
    title: "Corrected memory reuse",
    description: "A corrected preference is used and the replaced stale preference is not surfaced.",
    coverage: ["corrected_memory_reuse"],
    provider_responses: ["I will use the corrected Zed editor preference."],
    steps: [
      { kind: "memory_seed", key: "editor-preference", value: "The user prefers Vim.", memory_type: "preference" },
      {
        kind: "memory_correction",
        target_key: "editor-preference",
        replacement_key: "editor-preference-current",
        replacement_value: "The user prefers Zed.",
      },
      { kind: "user_turn", input: "Which editor should you assume?", expected_assistant: "Zed", memory_refs: ["editor-preference-current"] },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "stale-memory-rejected",
    seed: "eval-lab-seed-003",
    title: "Stale memory rejected",
    description: "A stale sensitive fact is corrected and withheld from normal projection.",
    coverage: ["stale_memory_rejected"],
    provider_responses: ["I will avoid the stale private fact and use the corrected Tokyo memory."],
    steps: [
      { kind: "memory_seed", key: "travel-plan", value: "The user is in Berlin.", memory_type: "fact", sensitivity: "private" },
      {
        kind: "memory_correction",
        target_key: "travel-plan",
        replacement_key: "travel-plan-current",
        replacement_value: "The user is in Tokyo.",
      },
      { kind: "user_turn", input: "Where should the local reminder be based?", expected_assistant: "Tokyo", memory_refs: ["travel-plan-current"] },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "schedule-wake-after-fake-time",
    seed: "eval-lab-seed-004",
    title: "Schedule wake after fake time",
    description: "A wait-resume schedule wakes after fake time is advanced.",
    coverage: ["schedule_wake_after_fake_time"],
    steps: [
      { kind: "schedule_wake", advance_ms: 3_600_000 },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "daemon-restart-pending-approval",
    seed: "eval-lab-seed-005",
    title: "Daemon restart during pending approval",
    description: "A pending approval survives a daemon-style broker restart before response.",
    coverage: ["daemon_restart_pending_approval"],
    steps: [
      { kind: "approval_response", approved: true, restart_daemon_before_response: true },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "duplicate-delivery-prevention-after-replay",
    seed: "eval-lab-seed-006",
    title: "Duplicate delivery prevention after replay",
    description: "Outbox and Telegram authority projections prevent duplicate delivery after replay.",
    coverage: ["duplicate_delivery_prevention_after_replay"],
    steps: [
      { kind: "delivery_replay", delivery_id: "peer-delivery:dedupe", duplicate_attempts: 2 },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "tool-capability-failure-recovery",
    seed: "eval-lab-seed-007",
    title: "Tool capability failure and recovery",
    description: "A production ToolExecutor invocation fails first and recovers on the next capability check.",
    coverage: ["tool_capability_failure_recovery"],
    steps: [
      { kind: "tool_capability", tool_name: "eval_lab_capability", fail_first: true },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "quiet-mode-proactivity-hold",
    seed: "eval-lab-seed-008",
    title: "Quiet mode proactivity hold",
    description: "Quiet mode holds a proactive notification instead of flushing backlog.",
    coverage: ["quiet_mode_proactivity_hold"],
    steps: [
      { kind: "quiet_mode", quieting_ref: "quiet:eight-hours", requested_delivery_kind: "notify" },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "overreach-feedback-lowers-intervention",
    seed: "eval-lab-seed-009",
    title: "Overreach feedback lowers future intervention",
    description: "Overreach feedback suppresses the next peer initiative candidate.",
    coverage: ["overreach_feedback_lowers_intervention"],
    steps: [
      { kind: "feedback", feedback_kind: "overreach", lowers_future_intervention: true },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "missed-help-detection",
    seed: "eval-lab-seed-010",
    title: "Missed help detection",
    description: "The lab records a missed-help opportunity and proves the candidate was held for review, not ignored.",
    coverage: ["missed_help_detection"],
    steps: [
      { kind: "feedback", feedback_kind: "missed_help", lowers_future_intervention: false },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "stale-action-binding-rejection",
    seed: "eval-lab-seed-011",
    title: "Stale action binding rejection",
    description: "A Telegram callback for a previous delivery is rejected by typed binding evidence.",
    coverage: ["stale_action_binding_rejection"],
    steps: [
      {
        kind: "stale_action_binding",
        callback_id: "callback:stale",
        current_delivery_id: "delivery:current",
        stale_delivery_id: "delivery:previous",
      },
      replay(),
    ],
  }),
  scenario({
    scenario_id: "gateway-telegram-projection-consistency",
    seed: "eval-lab-seed-012",
    title: "Gateway Telegram projection consistency",
    description: "Normal and operator Telegram projections agree on safe delivery status without exposing raw refs normally.",
    coverage: ["gateway_telegram_projection_consistency"],
    steps: [
      {
        kind: "telegram_projection",
        delivery_id: "delivery:telegram-consistency",
        conversation_id: "telegram:conversation:projection",
        transport_message_ref: "telegram-message:projection",
      },
      replay(),
    ],
  }),
];
