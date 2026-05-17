import type { EvalLabScenario, EvalLabStep } from "./types.js";

const STARTED_AT = "2026-05-17T00:00:00.000Z";

export const longRunEvalLabScenarios: EvalLabScenario[] = [
  scenario("multi_turn_chat_with_memory_use", "Multi-turn chat with memory use", [
    "fake user turns",
    "fake provider/model",
    "memory retrieval",
    "production chat caller path",
  ], [
    step("memory_seed", "seed-planning-memory", {
      label: "planning-window",
      key: "user.preference.planning_window",
      value: "The user prefers planning on Friday afternoon.",
      tags: ["preference", "planning"],
    }),
    step("fake_user_turn", "turn-1", {
      text: "Can you remember when I prefer planning?",
      refs: ["agent_memory:user.preference.planning_window"],
    }),
    step("memory_recall", "recall-planning", {
      query: "planning",
      expected_keys: ["user.preference.planning_window"],
    }),
    step("fake_provider_model", "model-reply-1", {
      phase: "answer_with_memory",
      prompt: "Use retrieved planning memory.",
    }),
    step("fake_user_turn", "turn-2", {
      text: "Use that for the next check-in.",
      refs: ["agent_memory:user.preference.planning_window"],
    }),
    step("event_log_replay", "replay-after-chat"),
  ], {
    model_script: [{
      request_phase: "answer_with_memory",
      response: { content: "You prefer planning on Friday afternoon." },
    }],
    required_event_types: ["gateway.chat.ingress.recorded"],
    required_runtime_graph_edge_kinds: ["decided_by"],
    minimums: { memory_retrieval_hit_rate: 1, replay_equivalence_rate: 1 },
  }),

  scenario("corrected_memory_reuse", "Corrected memory reuse", [
    "memory correction",
    "corrected memory reuse",
    "event-log replay",
  ], [
    step("memory_seed", "seed-stale-editor", {
      label: "editor-stale",
      key: "user.editor.preference",
      value: "The user prefers Atom.",
      tags: ["preference", "editor"],
    }),
    step("memory_correction", "correct-editor", {
      target_label: "editor-stale",
      operation: "correct",
      replacement_key: "user.editor.preference.current",
      replacement_value: "The user prefers VS Code.",
      replacement_label: "editor-current",
    }),
    step("memory_recall", "recall-editor-current", {
      query: "user.editor.preference.current",
      exact: true,
      expected_keys: ["user.editor.preference.current"],
      corrected_expected_keys: ["user.editor.preference.current"],
      stale_keys: ["user.editor.preference"],
    }),
    step("event_log_replay", "replay-corrected-memory"),
  ], {
    required_event_types: ["memory.correction.recorded"],
    required_runtime_graph_edge_kinds: ["invalidated_by"],
    minimums: {
      corrected_memory_reuse_rate: 1,
      stale_action_rejection_rate: 1,
      replay_equivalence_rate: 1,
    },
  }),

  scenario("stale_memory_rejected", "Stale memory rejected", [
    "stale memory rejected",
    "memory correction",
    "normal projection redaction",
  ], [
    step("memory_seed", "seed-stale-travel", {
      label: "travel-stale",
      key: "user.travel.window",
      value: "The user prefers trips in August.",
      tags: ["travel", "preference"],
    }),
    step("memory_correction", "forget-travel", {
      target_label: "travel-stale",
      operation: "forget",
    }),
    step("memory_recall", "recall-travel-stale", {
      query: "user.travel.window",
      exact: true,
      stale_keys: ["user.travel.window"],
      expected_keys: [],
    }),
    step("event_log_replay", "replay-stale-memory"),
  ], {
    required_event_types: ["memory.correction.recorded"],
    minimums: { stale_action_rejection_rate: 1 },
    maximums: { sensitive_leak_rate: 0 },
  }),

  scenario("schedule_wake_after_fake_time_advance", "Schedule wake after fake time advance", [
    "fake clock",
    "schedule wake",
    "RuntimeGraph",
  ], [
    step("fake_clock_advance", "advance-to-wake", { ms: 3_600_000 }),
    step("schedule_wake", "daily-check-in", {
      entry_id: "schedule:daily-check-in",
      name: "Daily check-in",
      scheduled_for: "2026-05-17T01:00:00.000Z",
      action_kind: "companion_check_in",
    }),
    step("event_log_replay", "replay-schedule-wake"),
  ], {
    required_event_types: ["schedule.wake.recorded"],
    required_runtime_graph_edge_kinds: ["decided_by"],
    minimums: { replay_equivalence_rate: 1 },
  }),

  scenario("daemon_restart_during_pending_approval", "Daemon restart during pending approval", [
    "approval",
    "daemon restart",
    "event-log replay",
  ], [
    step("approval_request", "approval-before-restart", {
      wait_plan_id: "permission-wait:restart-approval",
      value: "current",
    }),
    step("daemon_restart", "restart-before-approval"),
    step("approval_response", "resume-after-restart", {
      wait_plan_id: "permission-wait:restart-approval",
    }),
    step("event_log_replay", "replay-approval"),
  ], {
    required_event_types: ["approval.resume.recorded"],
    required_runtime_graph_edge_kinds: ["approved_by"],
    minimums: { replay_equivalence_rate: 1 },
    maximums: { approval_bypass_rate: 0 },
  }),

  scenario("duplicate_notification_delivery_prevention_after_replay", "Duplicate notification and delivery prevention after replay", [
    "fake Telegram/gateway",
    "daemon restart",
    "duplicate side-effect prevention",
    "event-log replay",
  ], [
    step("fake_telegram_gateway", "telegram-first", {
      candidate_id: "candidate:duplicate-delivery",
      delivery_id: "delivery:duplicate-delivery",
      transport_message_ref: "telegram:duplicate-delivery",
    }),
    step("event_log_replay", "replay-first-delivery"),
    step("fake_telegram_gateway", "telegram-duplicate", {
      candidate_id: "candidate:duplicate-delivery",
      delivery_id: "delivery:duplicate-delivery",
      transport_message_ref: "telegram:duplicate-delivery",
      duplicate_probe: true,
    }),
    step("event_log_replay", "replay-duplicate-delivery"),
  ], {
    required_event_types: ["gateway.telegram.delivery.recorded"],
    required_runtime_graph_edge_kinds: ["delivered_to"],
    minimums: { replay_equivalence_rate: 1 },
    maximums: { duplicate_side_effect_rate: 0 },
  }),

  scenario("tool_capability_failure_and_recovery", "Tool/capability failure and recovery", [
    "fake plugin/MCP/capability",
    "fake filesystem/workspace",
    "fake network",
    "scripted tool recovery",
  ], [
    step("fake_filesystem_workspace", "seed-workspace", {
      path: "capability/input.json",
      value: { capability: "local_eval", ready: true },
    }),
    step("fake_network", "network-guard", {
      url: "https://example.com/should-not-run",
    }),
    step("fake_plugin_capability", "capability-fails", {
      name: "eval_capability",
      args: { mode: "first" },
    }),
    step("fake_plugin_capability", "capability-recovers", {
      name: "eval_capability",
      args: { mode: "retry" },
    }),
  ], {
    tool_script: [{
      name: "eval_capability",
      result: { success: false, reason: "capability_unavailable" },
    }, {
      name: "eval_capability",
      result: { success: true, recovered: true },
      side_effect_artifact: { path: "workspace/capability/output.json" },
    }],
    maximums: { sensitive_leak_rate: 0 },
  }),

  scenario("quiet_mode_proactivity_hold", "Quiet mode proactivity hold", [
    "quiet mode",
    "proactivity control",
    "normal surface projection",
  ], [
    step("quiet_proactivity_control", "quiet-entered", {
      mode: "quiet",
    }),
    step("proactivity_decision", "quiet-decision", {
      requested_delivery_kind: "notify",
    }),
  ], {
    maximums: { duplicate_side_effect_rate: 0, approval_bypass_rate: 0 },
  }),

  scenario("overreach_feedback_lowers_future_intervention", "Overreach feedback lowers future intervention", [
    "feedback",
    "proactivity calibration",
    "overreach metric",
  ], [
    step("feedback", "overreach-feedback", {
      feedback_kind: "overreach",
    }),
    step("proactivity_decision", "after-overreach", {
      requested_delivery_kind: "notify",
    }),
  ], {
    minimums: { overreach_rate: 1 },
    maximums: { approval_bypass_rate: 0 },
  }),

  scenario("missed_help_scenario_detection", "Missed-help scenario detection", [
    "missed-help detection",
    "model-mediated judgment non-authoritative",
    "deterministic quality failure",
  ], [
    step("fake_user_turn", "user-deadline-signal", {
      text: "I have a deadline tomorrow and I keep forgetting the prep.",
      refs: ["deadline:tomorrow"],
    }),
    step("missed_help_observation", "missed-help-detected", {
      detected: true,
      message: "A deadline-risk signal was observed without an admitted helpful intervention.",
    }),
  ], {
    required_event_types: ["gateway.chat.ingress.recorded"],
    required_failure_codes: ["missed_help_detected"],
    minimums: { missed_help_rate: 1 },
  }),

  scenario("stale_action_binding_rejection", "Stale action binding rejection", [
    "approval response",
    "stale action binding rejection",
    "fail closed",
  ], [
    step("approval_request", "approval-for-current-binding", {
      wait_plan_id: "permission-wait:stale-binding",
      value: "current",
      session_id: "session:current",
    }),
    step("stale_action_binding", "reject-stale-binding", {
      wait_plan_id: "permission-wait:stale-binding",
      stale: true,
      actual_value: "mutated",
      actual_session_id: "session:old",
    }),
    step("event_log_replay", "replay-stale-binding"),
  ], {
    required_event_types: ["approval.resume.recorded"],
    minimums: { stale_action_rejection_rate: 1, replay_equivalence_rate: 1 },
    maximums: { approval_bypass_rate: 0 },
  }),

  scenario("gateway_telegram_projection_consistency", "Gateway/Telegram projection consistency", [
    "fake Telegram/gateway",
    "surface projection",
    "operator projection",
    "event-log replay",
  ], [
    step("fake_telegram_gateway", "telegram-projection", {
      candidate_id: "candidate:projection-consistency",
      delivery_id: "delivery:projection-consistency",
      target_binding_ref: "gateway:telegram:home_chat:projection",
      channel_policy_ref: "gateway:telegram:projection-policy",
      transport_message_ref: "telegram:projection-consistency",
    }),
    step("event_log_replay", "replay-projection-consistency"),
  ], {
    required_event_types: ["gateway.telegram.delivery.recorded"],
    required_runtime_graph_edge_kinds: ["delivered_to"],
    minimums: { replay_equivalence_rate: 1 },
    maximums: { sensitive_leak_rate: 0 },
  }),
];

function scenario(
  scenarioId: string,
  title: string,
  covers: string[],
  steps: EvalLabStep[],
  options: {
    model_script?: EvalLabScenario["model_script"];
    tool_script?: EvalLabScenario["tool_script"];
    required_event_types?: string[];
    required_runtime_graph_edge_kinds?: string[];
    required_failure_codes?: string[];
    minimums?: Partial<EvalLabScenario["expectations"]["metric_thresholds"]["minimums"]>;
    maximums?: Partial<EvalLabScenario["expectations"]["metric_thresholds"]["maximums"]>;
  } = {},
): EvalLabScenario {
  return {
    schema_version: "pulseed.eval-lab.scenario/v1",
    scenario_id: scenarioId,
    seed: `seed:${scenarioId}`,
    title,
    covers,
    started_at: STARTED_AT,
    steps,
    model_script: options.model_script ?? [],
    tool_script: options.tool_script ?? [],
    expectations: {
      metric_thresholds: {
        minimums: options.minimums ?? {},
        maximums: options.maximums ?? {},
      },
      required_event_types: options.required_event_types ?? [],
      required_runtime_graph_edge_kinds: options.required_runtime_graph_edge_kinds ?? [],
      required_failure_codes: options.required_failure_codes ?? [],
    },
  };
}

function step(kind: EvalLabStep["kind"], id: string, input: Record<string, unknown> = {}): EvalLabStep {
  return { kind, id, input };
}
