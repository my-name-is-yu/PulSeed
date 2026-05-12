export const LivingAutonomyDirectPathIds = [
  "schedule.goal_trigger",
  "schedule.wait_resume",
  "schedule.cron_probe_notification",
  "daemon.proactive_tick",
  "resident.curiosity",
  "resident.proactive_maintenance",
  "gateway.outbound",
  "notification.outbox",
  "runtime_control.executor",
  "event_server.trigger_create_task",
  "event_server.command_goal_lifecycle",
  "event_server.command_approval_response",
  "event_server.command_schedule_run_now",
  "event_server.command_runtime_control",
  "event_server.post_events",
  "event_server.file_ingestion",
  "event_server.sse_outbox_broadcast",
  "tui_chat_gateway.direct_route",
] as const;

export type LivingAutonomyDirectPathId = typeof LivingAutonomyDirectPathIds[number];

export type LivingAutonomySourceAuthority =
  | "user_authorized_existing_behavior"
  | "user_directed_ingress"
  | "agent_origin_internal"
  | "runtime_internal";

export type LivingAutonomyPathClassification =
  | "already_user_authorized_existing_behavior"
  | "convert_to_attention_operationplan_admission"
  | "quarantine_until_attention"
  | "explicitly_out_of_scope";

export type LivingAutonomyEffect =
  | "start_work"
  | "speak"
  | "notify"
  | "enqueue"
  | "execute"
  | "quiet_audit"
  | "internal_signal";

export interface LivingAutonomyDirectPathInventoryEntry {
  id: LivingAutonomyDirectPathId;
  label: string;
  sourceAuthority: LivingAutonomySourceAuthority;
  classification: LivingAutonomyPathClassification;
  ownerModules: readonly string[];
  possibleEffects: readonly LivingAutonomyEffect[];
  currentPreGateEffects: readonly LivingAutonomyEffect[];
  preGateAllowedEffects: readonly LivingAutonomyEffect[];
  requiresTypedAdmission: boolean;
  existingBehavior: string;
  nextAction: string;
}

const outwardEffects: readonly LivingAutonomyEffect[] = [
  "speak",
  "notify",
  "execute",
  "start_work",
  "enqueue",
];

export const LivingAutonomyDirectPathInventory: readonly LivingAutonomyDirectPathInventoryEntry[] = [
  {
    id: "schedule.goal_trigger",
    label: "User-created goal_trigger schedule",
    sourceAuthority: "user_authorized_existing_behavior",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/runtime/schedule/engine-layers.ts",
      "src/runtime/schedule/engine-execution.ts",
    ],
    possibleEffects: ["start_work", "execute", "quiet_audit"],
    currentPreGateEffects: ["start_work", "execute", "quiet_audit"],
    preGateAllowedEffects: ["start_work", "execute", "quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "Explicit schedule entries can run the configured goal through CoreLoop.",
    nextAction: "Preserve as user-authorized scheduled behavior; future slices should attach AttentionInput audit refs without blocking the existing explicit schedule contract.",
  },
  {
    id: "schedule.wait_resume",
    label: "Internal wait-resume schedule wake",
    sourceAuthority: "runtime_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/schedule/engine-layers.ts",
      "src/runtime/schedule/wait-projection.ts",
      "src/runtime/capability-operation-planner.ts",
    ],
    possibleEffects: ["internal_signal", "quiet_audit"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Wait-resume wakes produce typed attention projection and advisory OperationPlan hints instead of running the goal or notifying.",
    nextAction: "Move source refs into central AttentionInput intake and persist replay disposition.",
  },
  {
    id: "schedule.cron_probe_notification",
    label: "User-created cron/probe notification schedule",
    sourceAuthority: "user_authorized_existing_behavior",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/runtime/schedule/engine-layers.ts",
      "src/runtime/notification-dispatcher.ts",
    ],
    possibleEffects: ["notify", "quiet_audit"],
    currentPreGateEffects: ["notify", "quiet_audit"],
    preGateAllowedEffects: ["notify", "quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "Explicit cron/probe schedules may dispatch configured notifications when their user-created schedule policy says so.",
    nextAction: "Preserve as explicit schedule behavior; later slices should add admitted outcome refs for shared surface delivery where practical.",
  },
  {
    id: "daemon.proactive_tick",
    label: "Daemon proactive tick",
    sourceAuthority: "agent_origin_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/daemon/runner-resident-proactive.ts",
      "src/runtime/daemon/maintenance.ts",
    ],
    possibleEffects: ["internal_signal", "quiet_audit", "start_work"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "The tick enters resident autonomy as typed AttentionInput and can only produce internal signal/audit before an admitted outcome.",
    nextAction: "Preserve the resident autonomy orchestrator boundary and keep proactive follow-up behind admitted outcomes.",
  },
  {
    id: "resident.curiosity",
    label: "Resident curiosity cycle",
    sourceAuthority: "agent_origin_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/daemon/runner-resident-curiosity.ts",
      "src/platform/traits/curiosity-engine.ts",
    ],
    possibleEffects: ["internal_signal", "quiet_audit", "start_work"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Curiosity proposals are represented as durable attention agenda and resident OperationPlan candidates before any workful follow-up.",
    nextAction: "Keep curiosity output as agenda/proposal state unless initiative and outcome admission allows a visible or workful effect.",
  },
  {
    id: "resident.proactive_maintenance",
    label: "Resident proactive maintenance and dream maintenance",
    sourceAuthority: "agent_origin_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/daemon/runner-resident-dream.ts",
      "src/runtime/daemon/runner-resident-proactive.ts",
    ],
    possibleEffects: ["internal_signal", "quiet_audit", "start_work", "enqueue"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Sleep, dream, and maintenance branches are quarantined behind resident autonomy admission before quiet preparation or schedule mutation.",
    nextAction: "Preserve Dream hints as non-authoritative proposal evidence; hints must not grant execution authority.",
  },
  {
    id: "gateway.outbound",
    label: "Gateway outbound channel send/edit",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/gateway/non-tui-display-projector.ts",
      "src/runtime/gateway/http-channel-adapter.ts",
      "src/runtime/gateway/ws-channel-adapter.ts",
      "src/runtime/gateway/telegram-gateway-adapter.ts",
      "src/runtime/gateway/slack-channel-adapter.ts",
      "src/runtime/gateway/signal-gateway-adapter.ts",
      "src/runtime/gateway/discord-gateway-adapter.ts",
      "src/runtime/gateway/whatsapp-gateway-adapter.ts",
      "src/runtime/gateway/chat-event-rendering.ts",
    ],
    possibleEffects: ["speak", "notify", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Gateway adapters render the shared delivery projection linked to admitted OutcomeDecision/ExpressionDecision and channel presence policy.",
    nextAction: "Keep TUI, gateway, and Telegram-shaped delivery on the shared projection path.",
  },
  {
    id: "notification.outbox",
    label: "Runtime notification and outbox delivery",
    sourceAuthority: "runtime_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/store/outbox-store.ts",
      "src/runtime/notification-dispatcher.ts",
      "src/runtime/control/runtime-control-result-routing.ts",
    ],
    possibleEffects: ["notify", "enqueue", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Outbox and notification dispatchers require admitted delivery projections or explicit user-authorized schedule exceptions before outward delivery.",
    nextAction: "Keep runtime result routing linked to admitted outcome/expression delivery refs.",
  },
  {
    id: "runtime_control.executor",
    label: "Runtime-control executor",
    sourceAuthority: "runtime_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/control/runtime-control-service.ts",
      "src/runtime/control/daemon-runtime-control-executor.ts",
    ],
    possibleEffects: ["execute", "start_work", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Runtime-control executor runs only after typed runtime-control intent, permission, approval, autonomy checks, and resident outcome refs for proactive initiation.",
    nextAction: "Preserve `can execute != may initiate` by keeping execution capability separate from initiative admission.",
  },
  {
    id: "event_server.trigger_create_task",
    label: "EventServer trigger create_task/observe/wake ingress",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-trigger-handler.ts",
      "src/runtime/event/dispatcher.ts",
      "src/base/utils/event-spool.ts",
    ],
    possibleEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Trigger-derived work proposals are converted into replayable AttentionInput and OperationPlan candidates before they can enqueue work.",
    nextAction: "Keep trigger source refs, source epochs, and replay disposition attached to any admitted work proposal.",
  },
  {
    id: "event_server.command_goal_lifecycle",
    label: "EventServer goal lifecycle commands",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/event/server-router.ts",
    ],
    possibleEffects: ["start_work", "execute", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Goal lifecycle command envelopes and broadcasts carry typed admission and delivery refs before outward command/broadcast effects.",
    nextAction: "Preserve explicit operator command semantics while keeping outward effects tied to admission evidence.",
  },
  {
    id: "event_server.command_approval_response",
    label: "EventServer approval-response command",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-router.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/command-dispatcher.ts",
    ],
    possibleEffects: ["execute", "start_work", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "The /goals/:id/approve HTTP route carries approval_response and approval_resolved through the feedback, permission, and admission loop with pending-request refs before held work can resume.",
    nextAction: "Keep approval-response effects linked to the held request, feedback ingestion, and resumed outcome evidence.",
  },
  {
    id: "event_server.command_schedule_run_now",
    label: "EventServer schedule run-now command",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/schedule/engine-execution.ts",
    ],
    possibleEffects: ["start_work", "execute", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Schedule run-now command admission uses the explicit user-directed operation boundary before command/broadcast effects.",
    nextAction: "Keep run-now command delivery tied to admitted schedule operation evidence.",
  },
  {
    id: "event_server.command_runtime_control",
    label: "EventServer daemon runtime-control command",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-router.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/command-dispatcher.ts",
    ],
    possibleEffects: ["execute", "start_work", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "The /daemon/runtime-control HTTP route attaches attention admission and delivery refs before runtime-control command emission.",
    nextAction: "Preserve executor approval/permission separation and admitted delivery refs for operator-visible control requests.",
  },
  {
    id: "event_server.post_events",
    label: "EventServer POST /events external event ingress",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-router.ts",
      "src/runtime/event/dispatcher.ts",
      "src/platform/drive/drive-system.ts",
      "src/base/utils/event-spool.ts",
      "src/runtime/gateway/http-channel-adapter.ts",
    ],
    possibleEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "POST /events accepts authorized events as replayable AttentionInput records before event-spool enqueue or goal activation.",
    nextAction: "Keep HTTP event source epochs, replay keys, and admitted outcomes attached before work activation.",
  },
  {
    id: "event_server.file_ingestion",
    label: "EventServer file-ingestion event spool",
    sourceAuthority: "runtime_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-file-ingestion.ts",
      "src/runtime/event/dispatcher.ts",
      "src/base/utils/event-spool.ts",
    ],
    possibleEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    currentPreGateEffects: ["internal_signal", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "File ingestion treats parsed runtime events as replayable AttentionInput sources with source epoch and replay disposition before work activation.",
    nextAction: "Keep stale, duplicate, and replayed event files fail-closed before work activation.",
  },
  {
    id: "event_server.sse_outbox_broadcast",
    label: "EventServer SSE and outbox broadcast",
    sourceAuthority: "runtime_internal",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-sse.ts",
      "src/runtime/store/outbox-store.ts",
    ],
    possibleEffects: ["notify", "enqueue", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "SSE broadcast and outbox payloads require admitted delivery projection refs except explicit operator diagnostic streams.",
    nextAction: "Keep event-stream payloads evidence-backed and distinguish diagnostic streams from user-facing delivery.",
  },
  {
    id: "tui_chat_gateway.direct_route",
    label: "TUI/chat/gateway direct ChatRunner route",
    sourceAuthority: "user_directed_ingress",
    classification: "convert_to_attention_operationplan_admission",
    ownerModules: [
      "src/interface/chat/chat-runner.ts",
      "src/interface/chat/chat-runner-routes.ts",
      "src/interface/tui/chat.tsx",
    ],
    possibleEffects: ["speak", "execute", "quiet_audit"],
    currentPreGateEffects: ["quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "User-directed chat routes keep ChatRunner as the turn engine and carry admitted delivery refs through TUI and non-TUI surfaces.",
    nextAction: "Preserve shared delivery projection for TUI, gateway, and Telegram-shaped direct turns.",
  },
] as const;

export function directPathInventoryById(): Map<LivingAutonomyDirectPathId, LivingAutonomyDirectPathInventoryEntry> {
  return new Map(LivingAutonomyDirectPathInventory.map((entry) => [entry.id, entry]));
}

export function requiresAdmissionBeforeOutwardEffect(entry: LivingAutonomyDirectPathInventoryEntry): boolean {
  if (entry.classification === "already_user_authorized_existing_behavior") return false;
  return entry.possibleEffects.some((effect) => outwardEffects.includes(effect));
}

export function forbiddenPreGateOutwardEffects(entry: LivingAutonomyDirectPathInventoryEntry): LivingAutonomyEffect[] {
  if (entry.classification === "already_user_authorized_existing_behavior") return [];
  return entry.preGateAllowedEffects.filter((effect) => outwardEffects.includes(effect));
}

export function currentPreGateOutwardEffects(entry: LivingAutonomyDirectPathInventoryEntry): LivingAutonomyEffect[] {
  if (entry.classification === "already_user_authorized_existing_behavior") return [];
  return entry.currentPreGateEffects.filter((effect) => outwardEffects.includes(effect));
}
