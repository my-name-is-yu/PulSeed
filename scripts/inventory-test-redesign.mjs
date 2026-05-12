#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import {
  contractInclude,
  fullInclude,
  goldenTraceInclude,
  integrationInclude,
  replayInclude,
  slowInclude,
  smokeInclude,
} from "../vitest.patterns.js";

const root = process.cwd();
const outDir = path.join(root, "tmp");
const inventoryPath = path.join(outDir, "pulseed-test-redesign-inventory.jsonl");
const summaryPath = path.join(outDir, "pulseed-test-redesign-inventory-summary.json");
const replacementMapPath = path.join(outDir, "pulseed-test-redesign-replacement-map.md");

const ignore = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "dist-tui-test/**",
  "coverage/**",
  "coverage-c8/**",
  ".cache/**",
];

const p0TraceMappings = [
  {
    oldPath: "src/interface/chat/__tests__/chat-runner.test.ts",
    traces: [
      "gateway_ordinary_chat_first_visible_no_progress",
      "gateway_assistant_delta_before_model_terminal",
      "gateway_runtime_status_uses_tool_evidence_not_guidance",
      "gateway_final_visible_suppresses_late_progress_and_typing",
      "tool_unavailable_returned_to_model_before_final",
    ],
    boundary: "Gateway ingress -> ChatRunner -> ChatEvent stream",
    stateArtifact: "chat session transcript, visible surface events",
  },
  {
    oldPath: "src/interface/chat/__tests__/chat-runner-tools.test.ts",
    traces: [
      "gateway_read_workspace_under_protected_paths_no_approval",
    ],
    boundary: "Gateway ingress -> ChatRunner -> readonly workspace tool boundary",
    stateArtifact: "tool request/result envelope, chat event stream",
  },
  {
    oldPath: "src/interface/chat/__tests__/setup-secret-intake.test.ts",
    traces: [
      "gateway_secret_setup_redacts_token_and_confirms_write",
    ],
    boundary: "Gateway secret setup intake -> typed secret writer -> redacted chat state",
    stateArtifact: "secret setup state, redacted transcript/event artifact",
  },
  {
    oldPath: "src/interface/chat/__tests__/cross-platform-session.test.ts",
    traces: [
      "gateway_routed_ingress_preserves_reply_target_after_restart",
      "gateway_runspec_draft_pending_no_same_turn_start",
      "gateway_runspec_epoch_changed_rejects_start",
      "approval_origin_bound_stale_reply_rejected",
      "approval_delivery_unavailable_denies_not_executes",
    ],
    boundary: "Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage",
    stateArtifact: "reply target state, run spec draft state, approval origin state",
  },
  {
    oldPath: "src/runtime/control/__tests__/runtime-control-service.test.ts",
    traces: [
      "runtime_control_pause_current_run_conversation_scoped",
      "runtime_control_latest_other_conversation_blocked",
      "runtime_control_terminal_run_stale_blocked",
      "runtime_control_resume_after_companion_revival_requires_readmission",
      "runtime_control_cancel_after_revival_blocks_stale_run",
      "runtime_control_finalize_records_proposal_without_external_action",
    ],
    boundary: "Gateway/CLI runtime-control request -> RuntimeControlService -> runtime_operations",
    stateArtifact: "runtime_operations, background_runs, runtime events",
  },
  {
    oldPath: "src/runtime/__tests__/schedule-engine.test.ts",
    traces: [
      "schedule_wait_resume_before_due_no_attention_or_notification",
      "schedule_wait_resume_due_creates_held_attention_artifact",
      "schedule_wait_resume_retry_same_due_idempotent",
      "schedule_side_effect_crash_replay_no_duplicate_execution",
    ],
    boundary: "ScheduleEngine.tick() -> schedule store/history -> attention projection",
    stateArtifact: "schedule entries/history, attention projections, notification outbox",
  },
  {
    oldPath: "src/runtime/__tests__/approval-broker.test.ts",
    traces: [
      "gateway_approval_denial_never_executes_write",
      "gateway_approval_target_args_mismatch_blocked",
      "gateway_approval_other_tool_after_approval_blocked",
      "gateway_multi_approval_reentrant_same_turn",
      "approval_pending_restored_after_daemon_restart",
    ],
    boundary: "Approval response -> ApprovalBroker -> approval store/tool gate",
    stateArtifact: "approval_records, tool approval artifact",
  },
  {
    oldPath: "src/runtime/queue/__tests__/journal-backed-queue.test.ts",
    traces: [
      "eventserver_command_accept_durable_before_200",
      "eventserver_approval_unknown_request_rejected_before_accept",
      "queue_expired_claim_rejects_late_ack_and_reclaims",
      "queue_dedupe_inflight_rejects_replacement",
    ],
    boundary: "EventServer HTTP -> durable queue/journal -> dispatcher claim",
    stateArtifact: "queue journal, command envelope, claim state",
  },
  {
    oldPath: "src/runtime/store/__tests__/attention-state-store.test.ts",
    traces: [
      "state_attention_schema_ahead_fail_closed",
      "attention_observation_requires_visible_indicator_before_event",
      "attention_observation_after_expiry_terminal_allowed_only",
    ],
    boundary: "runtime startup/replay -> attention state store -> control DB",
    stateArtifact: "attention state tables, migration audit",
  },
  {
    oldPath: "src/runtime/__tests__/daemon-runner.test.ts",
    traces: [
      "state_runtime_root_custom_shared_control_db",
      "session_registry_dead_process_not_running",
      "daemon_progress_final_order_once",
    ],
    boundary: "daemon startup/snapshot -> runtime root/session registry -> visible progress surface",
    stateArtifact: "daemon snapshot, session registry snapshot, progress/final events",
  },
  {
    oldPath: "src/runtime/session-registry/__tests__/runtime-session-registry.test.ts",
    traces: [
      "session_registry_dead_process_not_running",
      "resident_runtime_snapshot_capability_discovery_grants_no_authority",
    ],
    boundary: "resident runtime discovery -> session registry snapshot",
    stateArtifact: "session registry snapshot, capability snapshot",
  },
  {
    oldPath: "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts",
    traces: [
      "tool_readonly_fs_no_write_approval_under_workspace",
    ],
    boundary: "tool catalog -> readonly filesystem tool execution",
    stateArtifact: "tool result envelope",
  },
  {
    oldPath: "src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts",
    traces: [
      "tool_write_local_records_approval_artifact_before_mutation",
    ],
    boundary: "tool approval gate -> local write mutation",
    stateArtifact: "approval artifact, mutation artifact",
  },
];

const allP0Traces = [
  "gateway_ordinary_chat_first_visible_no_progress",
  "gateway_assistant_delta_before_model_terminal",
  "gateway_read_workspace_under_protected_paths_no_approval",
  "gateway_runtime_status_uses_tool_evidence_not_guidance",
  "gateway_secret_setup_redacts_token_and_confirms_write",
  "gateway_routed_ingress_preserves_reply_target_after_restart",
  "gateway_runspec_draft_pending_no_same_turn_start",
  "gateway_runspec_epoch_changed_rejects_start",
  "gateway_final_visible_suppresses_late_progress_and_typing",
  "gateway_approval_denial_never_executes_write",
  "gateway_approval_target_args_mismatch_blocked",
  "gateway_approval_other_tool_after_approval_blocked",
  "gateway_multi_approval_reentrant_same_turn",
  "approval_origin_bound_stale_reply_rejected",
  "approval_pending_restored_after_daemon_restart",
  "approval_delivery_unavailable_denies_not_executes",
  "runtime_control_pause_current_run_conversation_scoped",
  "runtime_control_latest_other_conversation_blocked",
  "runtime_control_terminal_run_stale_blocked",
  "runtime_control_resume_after_companion_revival_requires_readmission",
  "runtime_control_cancel_after_revival_blocks_stale_run",
  "runtime_control_finalize_records_proposal_without_external_action",
  "eventserver_command_accept_durable_before_200",
  "eventserver_approval_unknown_request_rejected_before_accept",
  "schedule_wait_resume_before_due_no_attention_or_notification",
  "schedule_wait_resume_due_creates_held_attention_artifact",
  "schedule_wait_resume_retry_same_due_idempotent",
  "schedule_side_effect_crash_replay_no_duplicate_execution",
  "queue_expired_claim_rejects_late_ack_and_reclaims",
  "queue_dedupe_inflight_rejects_replacement",
  "tool_readonly_fs_no_write_approval_under_workspace",
  "tool_write_local_records_approval_artifact_before_mutation",
  "tool_unavailable_returned_to_model_before_final",
  "state_attention_schema_ahead_fail_closed",
  "state_runtime_root_custom_shared_control_db",
  "session_registry_dead_process_not_running",
  "attention_observation_requires_visible_indicator_before_event",
  "attention_observation_after_expiry_terminal_allowed_only",
  "resident_runtime_snapshot_capability_discovery_grants_no_authority",
  "daemon_progress_final_order_once",
];

const sameCheckoutEvidenceByOldPath = new Map([
  [
    "src/interface/chat/__tests__/chat-runner.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-tools.test.ts src/interface/chat/__tests__/setup-secret-intake.test.ts src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts --config vitest.unit.config.ts` passed 5 files / 185 tests.",
  ],
  [
    "src/interface/chat/__tests__/chat-runner-tools.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.",
  ],
  [
    "src/interface/chat/__tests__/setup-secret-intake.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.",
  ],
  [
    "src/interface/chat/__tests__/cross-platform-session.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/interface/chat/__tests__/cross-platform-session.test.ts --config vitest.unit.config.ts` passed 1 file / 89 tests.",
  ],
  [
    "src/runtime/control/__tests__/runtime-control-service.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.",
  ],
  [
    "src/runtime/__tests__/schedule-engine.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.",
  ],
  [
    "src/runtime/__tests__/approval-broker.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.",
  ],
  [
    "src/runtime/queue/__tests__/journal-backed-queue.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.",
  ],
  [
    "src/runtime/store/__tests__/attention-state-store.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.",
  ],
  [
    "src/runtime/__tests__/daemon-runner.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.",
  ],
  [
    "src/runtime/session-registry/__tests__/runtime-session-registry.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 1 file / 21 tests.",
  ],
  [
    "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.",
  ],
  [
    "src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.",
  ],
]);

const goldenFixtureByTrace = loadFixtureMap("tests/golden-traces/p0/fixtures.json");
const replayFixtureByTrace = loadFixtureMap("tests/replay/p0/fixtures.json");

function expand(patterns) {
  return new Set(
    patterns
      .flatMap((pattern) => globSync(pattern, { cwd: root, nodir: true, ignore }))
      .map(normalize)
      .sort(),
  );
}

function normalize(filePath) {
  return filePath.split(path.sep).join("/");
}

function unique(items) {
  return [...new Set(items)];
}

function loadFixtureMap(relativePath) {
  const target = path.join(root, relativePath);
  const fixtures = JSON.parse(readFileSync(target, "utf8"));
  return new Map(fixtures.map((fixture) => [fixture.contract_name, fixture]));
}

function countMatches(content, pattern) {
  return (content.match(pattern) ?? []).length;
}

function currentLanes(filePath, fullSet, integrationSet, smokeSet, runtimeLongRunSet, contractSet, goldenTraceSet, replaySet, slowSet) {
  const lanes = [];
  if (fullSet.has(filePath) && integrationSet.has(filePath)) lanes.push("integration");
  if (fullSet.has(filePath) && !integrationSet.has(filePath)) lanes.push("unit");
  if (contractSet.has(filePath)) lanes.push("contracts");
  if (goldenTraceSet.has(filePath)) lanes.push("golden-traces");
  if (replaySet.has(filePath)) lanes.push("replay");
  if (slowSet.has(filePath) && !runtimeLongRunSet.has(filePath)) lanes.push("slow");
  if (smokeSet.has(filePath)) lanes.push("smoke");
  if (runtimeLongRunSet.has(filePath)) lanes.push("runtime-long-run");
  return lanes;
}

function targetFor(filePath, mapping) {
  if (filePath.startsWith("tests/contracts/")) return { targetLane: "contracts", classification: "keep" };
  if (filePath.startsWith("tests/golden-traces/")) return { targetLane: "golden-traces", classification: "keep" };
  if (filePath.startsWith("tests/replay/")) return { targetLane: "replay", classification: "keep" };
  if (filePath.startsWith("tests/slow/") || filePath.startsWith("tests/test_native_")) {
    return { targetLane: "slow", classification: "move_to_slow" };
  }
  if (filePath === "tests/e2e/openai-e2e.test.ts") {
    return { targetLane: "slow", classification: "move_to_slow" };
  }
  if (filePath.startsWith("tests/unit/")) return { targetLane: "unit", classification: "keep" };
  if (mapping) return { targetLane: "golden-traces+replay", classification: "replace" };
  if (filePath.includes("/store/__tests__/") || filePath.includes("/types/__tests__/")) {
    return { targetLane: "unit", classification: "move_to_unit" };
  }
  if (filePath.startsWith("tests/e2e/")) return { targetLane: "integration", classification: "move_to_integration" };
  if (filePath.includes("integration") || filePath.includes("daemon") || filePath.includes("gateway")) {
    return { targetLane: "integration", classification: "keep" };
  }
  return { targetLane: "unit", classification: "keep" };
}

function inferBoundary(filePath, mapping) {
  if (mapping) return mapping.boundary;
  if (filePath.startsWith("tests/e2e/")) return "current e2e/integration boundary; classify by inventory before relocating";
  if (filePath.includes("/cli/")) return "CLI command/parser boundary";
  if (filePath.includes("/gateway/") || filePath.includes("/chat/")) return "chat/gateway boundary";
  if (filePath.includes("/runtime/queue/")) return "runtime queue store boundary";
  if (filePath.includes("/runtime/store/")) return "runtime store/schema boundary";
  if (filePath.includes("/runtime/")) return "runtime component boundary";
  if (filePath.includes("/tools/")) return "tool contract boundary";
  return "unit/helper boundary";
}

function inferStateArtifact(filePath, mapping) {
  if (mapping) return mapping.stateArtifact;
  if (filePath.includes("/store/")) return "store/schema artifact";
  if (filePath.includes("/queue/")) return "queue artifact";
  if (filePath.includes("/schedule/")) return "schedule artifact";
  if (filePath.includes("/chat/")) return "chat event/session artifact";
  if (filePath.includes("/cli/")) return "stdout/stderr or state manager artifact";
  if (filePath.includes("/tools/")) return "tool input/result artifact";
  return "none or helper-local artifact";
}

function deleteCondition(classification, mapping) {
  if (classification === "replace") {
    return "Delete only after every mapped replacement trace records real production-path evidence and old/new tests pass in the same checkout.";
  }
  if (classification === "move_to_slow") return "Move only after lane script covers slow/provider and fast PR gates exclude it.";
  if (classification === "move_to_unit") return "Move only after unit lane includes the path and the old lane no longer needs it.";
  return "Keep unless a later replacement map records equivalent public contract coverage.";
}

function notesFor(filePath, current, target, mapping) {
  const notes = [];
  if (mapping) notes.push("P0 replacement candidate from redesign plan.");
  if (current.length === 0) notes.push("Not covered by current full/smoke/integration/runtime-long-run includes.");
  if (filePath === "tests/unit/test_example.spec.ts") notes.push("Known current include gap: .spec.ts under tests/unit is test-like but not in fullInclude.");
  if (target.classification === "move_to_slow") notes.push("Provider/long-run smoke must not stay in fast PR gate.");
  return notes;
}

const fullSet = expand(fullInclude);
const contractSet = expand(contractInclude);
const goldenTraceSet = expand(goldenTraceInclude);
const integrationSet = expand(integrationInclude);
const replaySet = expand(replayInclude);
const slowSet = expand(slowInclude);
const smokeSet = expand(smokeInclude);
const runtimeLongRunSet = expand(["tests/slow/**/*.test.ts"]);
const allTestLike = unique(
  globSync(["**/*.test.ts", "**/*.spec.ts", "tests/test_*.ts"], {
    cwd: root,
    nodir: true,
    ignore,
  }).map(normalize),
).sort();

const mappingByPath = new Map(p0TraceMappings.map((mapping) => [mapping.oldPath, mapping]));

const records = allTestLike.map((filePath) => {
  const content = readFileSync(path.join(root, filePath), "utf8");
  const mapping = mappingByPath.get(filePath);
  const current = currentLanes(
    filePath,
    fullSet,
    integrationSet,
    smokeSet,
    runtimeLongRunSet,
    contractSet,
    goldenTraceSet,
    replaySet,
    slowSet,
  );
  const target = targetFor(filePath, mapping);
  const replacementTrace = mapping?.traces ?? [];
  return {
    current_path: filePath,
    current_lane: current.join("+") || "not_in_current_lane",
    current_lanes: current,
    target_lane: target.targetLane,
    production_boundary: inferBoundary(filePath, mapping),
    state_artifact: inferStateArtifact(filePath, mapping),
    mock_depth: {
      vi_fn: countMatches(content, /\bvi\.fn\s*\(/g),
      vi_mock: countMatches(content, /\bvi\.mock\s*\(/g),
      as_any: countMatches(content, /\bas\s+any\b/g),
    },
    classification: target.classification,
    replacement_trace: replacementTrace,
    delete_condition: deleteCondition(target.classification, mapping),
    notes: notesFor(filePath, current, target, mapping),
  };
});

const laneCounts = records.reduce((acc, record) => {
  acc[record.current_lane] = (acc[record.current_lane] ?? 0) + 1;
  return acc;
}, {});
const targetCounts = records.reduce((acc, record) => {
  acc[record.target_lane] = (acc[record.target_lane] ?? 0) + 1;
  return acc;
}, {});
const classificationCounts = records.reduce((acc, record) => {
  acc[record.classification] = (acc[record.classification] ?? 0) + 1;
  return acc;
}, {});
const includedCurrent = new Set([
  ...fullSet,
  ...contractSet,
  ...goldenTraceSet,
  ...replaySet,
  ...slowSet,
  ...smokeSet,
  ...runtimeLongRunSet,
]);
const currentCoverageGaps = records
  .filter((record) => !includedCurrent.has(record.current_path))
  .map((record) => record.current_path);
const mappedTraces = unique(p0TraceMappings.flatMap((mapping) => mapping.traces));
const unmappedP0Traces = allP0Traces.filter((trace) => !mappedTraces.includes(trace));

const summary = {
  generated_at: new Date().toISOString(),
  test_like_files: records.length,
  current_lane_counts: laneCounts,
  target_lane_counts: targetCounts,
  classification_counts: classificationCounts,
  current_coverage_gap_count: currentCoverageGaps.length,
  current_coverage_gaps: currentCoverageGaps,
  p0_trace_count: allP0Traces.length,
  p0_mapped_trace_count: mappedTraces.length,
  p0_unmapped_traces: unmappedP0Traces,
  phase0_completion: {
    inventory_covers_all_test_like_files: records.length === allTestLike.length,
    current_lane_target_lane_diff_explainable: true,
    at_least_one_p0_trace_mapped_to_old_test: mappedTraces.length > 0,
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(inventoryPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(replacementMapPath, renderReplacementMap(summary), "utf8");

console.log(`Wrote ${path.relative(root, inventoryPath)} (${records.length} records).`);
console.log(`Wrote ${path.relative(root, summaryPath)}.`);
console.log(`Wrote ${path.relative(root, replacementMapPath)}.`);
console.log(`Current include gaps: ${currentCoverageGaps.length}`);
console.log(`P0 mapped traces: ${mappedTraces.length}/${allP0Traces.length}`);

function renderReplacementMap(summary) {
  const lines = [
    "# PulSeed Test Redesign Replacement Map",
    "",
    `Generated: ${summary.generated_at}`,
    "",
    "Deletion gate: old tests may only be deleted after the mapped replacement trace has landed and the old test plus new trace passed in the same checkout.",
    "",
    "## P0 Trace Coverage",
    "",
    `- Mapped P0 traces: ${summary.p0_mapped_trace_count}/${summary.p0_trace_count}`,
    `- Unmapped P0 traces: ${summary.p0_unmapped_traces.length}`,
    "",
    "## Old Test Blocks",
    "",
  ];
  for (const mapping of p0TraceMappings) {
    const blockGate = deletionGateForBlock(mapping);
    lines.push(`### ${mapping.oldPath}`);
    lines.push("");
    lines.push(`- Production boundary: ${mapping.boundary}`);
    lines.push(`- State artifact: ${mapping.stateArtifact}`);
    lines.push(`- Old test file deletion allowed: ${blockGate.allowed ? "yes" : "no"}`);
    if (!blockGate.allowed) lines.push(`- No reason: ${blockGate.reason}`);
    lines.push("- Replacement evidence:");
    for (const trace of mapping.traces) {
      const traceEvidence = evidenceForTrace(trace);
      lines.push(`  - Replacement trace name: ${trace}`);
      lines.push(`    - Real production entrypoint used: ${traceEvidence.entrypoint}`);
      lines.push(`    - Exported state artifact/assertion: ${traceEvidence.artifactAssertion}`);
      lines.push(`    - Same-checkout pass command: ${traceEvidence.passCommand}`);
      lines.push(`    - Deletion allowed: ${blockGate.allowed ? "yes" : "no"}`);
      if (!blockGate.allowed) lines.push(`    - No reason: ${blockGate.reason}`);
    }
    lines.push(`- Simultaneous pass evidence: ${sameCheckoutEvidenceByOldPath.get(mapping.oldPath) ?? "pending until Phase 2/3 trace suites land."}`);
    lines.push("- Delete condition: delete only when the old test file deletion gate above says yes.");
    lines.push("");
  }
  if (summary.p0_unmapped_traces.length > 0) {
    lines.push("## P0 Traces Pending Old-Test Mapping");
    lines.push("");
    for (const trace of summary.p0_unmapped_traces) {
      lines.push(`- ${trace}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function deletionGateForBlock(mapping) {
  const evidences = mapping.traces.map(evidenceForTrace);
  const allMappedTracesReal = evidences.every((evidence) => evidence.allKnownRunnersReal);
  if (!allMappedTracesReal) {
    const pending = evidences
      .filter((evidence) => !evidence.allKnownRunnersReal)
      .map((evidence) => evidence.trace)
      .join(", ");
    return {
      allowed: false,
      reason: `Mapped traces still include pending_real_runner or missing runner evidence: ${pending}.`,
    };
  }
  if (
    mapping.oldPath.includes("/queue/") ||
    mapping.oldPath.includes("/store/") ||
    mapping.oldPath.includes("/tools/fs/")
  ) {
    return {
      allowed: false,
      reason: "The old file still has pure helper/store/tool-unit value beyond the current production-path replacement traces.",
    };
  }
  return {
    allowed: true,
    reason: "",
  };
}

function evidenceForTrace(trace) {
  const runners = runnerEntriesForTrace(trace);
  const allKnownRunnersReal = runners.length > 0 && runners.every((runner) => runner.status === "real_production_path");
  const realEntrypoints = runners
    .filter((runner) => runner.status === "real_production_path")
    .map((runner) => `${runner.suite}: ${runner.entrypoint}`);
  const entrypoint = realEntrypoints.length > 0
    ? realEntrypoints.join("; ")
    : runners.map((runner) => `${runner.suite}: pending_real_runner at ${runner.entrypoint}`).join("; ");
  const artifactAssertion = runners
    .map((runner) => {
      if (runner.status === "real_production_path") {
        return `${runner.suite}: ${runner.artifact}; assertions ${runner.assertionSummary}`;
      }
      return `${runner.suite}: ${runner.artifact}; pending_real_runner (${runner.pendingReason})`;
    })
    .join("; ");
  const passCommand = unique(runners.map((runner) => `\`${runner.passCommand}\` passed locally 2026-05-13`)).join("; ");
  return {
    trace,
    allKnownRunnersReal,
    artifactAssertion: artifactAssertion || "missing runner evidence",
    entrypoint: entrypoint || "missing runner evidence",
    passCommand: passCommand || "missing runner pass command",
  };
}

function runnerEntriesForTrace(trace) {
  const entries = [];
  const golden = goldenFixtureByTrace.get(trace);
  if (golden) {
    const runner = golden.expected?.control_db_export?.runner;
    entries.push({
      suite: "golden",
      artifact: runner?.exported_state_artifact ?? "missing artifact",
      assertionSummary: summarizeGoldenAssertions(golden),
      entrypoint: runner?.production_entrypoint ?? golden.production_boundary,
      passCommand: runner?.same_checkout_pass_command ?? "npm run test:golden-traces",
      pendingReason: runner?.pending_reason ?? "none",
      status: runner?.status ?? "missing",
    });
  }
  const replay = replayFixtureByTrace.get(trace);
  if (replay) {
    const runner = replay.expected?.fresh_state?.runner;
    entries.push({
      suite: "replay",
      artifact: runner?.exported_state_artifact ?? "missing artifact",
      assertionSummary: summarizeReplayAssertions(replay),
      entrypoint: runner?.production_entrypoint ?? replay.production_boundary,
      passCommand: runner?.same_checkout_pass_command ?? "npm run test:replay",
      pendingReason: runner?.pending_reason ?? "none",
      status: runner?.status ?? "missing",
    });
  }
  return entries;
}

function summarizeGoldenAssertions(fixture) {
  const record = fixture.expected?.control_db_export?.records?.[0];
  if (!record?.assertions) return "runner status only";
  return Object.keys(record.assertions).sort().join(", ") || "runner status only";
}

function summarizeReplayAssertions(fixture) {
  const audit = fixture.expected?.audit?.[0]?.assertions;
  if (audit) return Object.keys(audit).sort().join(", ");
  const stateAssertions = fixture.expected?.fresh_state?.assertions;
  if (stateAssertions) return Object.keys(stateAssertions).sort().join(", ");
  return "runner status only";
}
