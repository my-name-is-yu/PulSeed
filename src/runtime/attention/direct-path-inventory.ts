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
  currentDebt?: string;
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
    currentPreGateEffects: ["internal_signal", "quiet_audit", "start_work"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "The tick can ask the proactive LLM for sleep, suggest_goal, investigate, or preemptive_check; visible output is not emitted from the tick.",
    nextAction: "Route proactive decisions through AttentionInput, urge/agenda, inhibition, initiative gate, and admitted outcomes before any workful follow-up.",
    currentDebt: "The proactive decision dispatcher can still call resident branches that do work before the new resident autonomy admission boundary exists.",
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
    currentPreGateEffects: ["internal_signal", "quiet_audit", "start_work"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Curiosity may generate internal proposals and resident_activity records; it should not speak or notify directly.",
    nextAction: "Convert generated proposals into durable attention agenda and OperationPlan candidates.",
    currentDebt: "Curiosity proposal generation is still called directly from resident schedule/proactive paths before durable attention admission.",
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
    currentPreGateEffects: ["internal_signal", "quiet_audit", "start_work", "enqueue"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Sleep/maintenance paths can apply pending dream suggestions or run light/deep analysis without user-visible output.",
    nextAction: "Quarantine direct maintenance branches behind the resident autonomy orchestrator before allowing quiet preparation or schedule mutation.",
    currentDebt: "Idle dream maintenance can still call DreamScheduleSuggestionStore.applySuggestion() and scheduleEngine.addEntry() before typed resident admission.",
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
    currentPreGateEffects: ["speak", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Gateway adapters render ChatRunner events and channel presence directly.",
    nextAction: "Use one shared delivery projection linked to admitted OutcomeDecision/ExpressionDecision for TUI, gateway, and Telegram.",
    currentDebt: "Current non-TUI adapters can still project chat events directly; #1919/#1920 and shared delivery must close this before readiness claims.",
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
    currentPreGateEffects: ["notify", "enqueue", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Outbox and notification dispatchers can carry runtime results to external channels.",
    nextAction: "Require admitted delivery projections or explicit user-authorized schedule exceptions before outward delivery.",
    currentDebt: "Runtime result routing and outbox delivery need admitted delivery refs, except explicit user-authorized schedule notifications.",
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
    currentPreGateEffects: ["execute", "start_work", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Runtime-control executor runs only after typed runtime-control intent, permission, approval, and autonomy checks.",
    nextAction: "Preserve executor separation and attach resident AttentionInput/OutcomeDecision refs before proactive initiation.",
    currentDebt: "Executor safeguards exist, but resident-initiated uses still need admitted attention outcome refs before this path is considered closed.",
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
    currentPreGateEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Trigger mappings can dispatch observed events or write create_task events into the event spool.",
    nextAction: "Convert trigger-derived work proposals into AttentionInput and OperationPlan candidates before they can enqueue work.",
    currentDebt: "create_task writes an event-spool record directly, and goal-linked observe/wake events can activate work before the new attention replay/admission boundary is attached.",
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
    currentPreGateEffects: ["start_work", "enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Goal start/stop/pause/resume/chat commands dispatch command envelopes and broadcast request events.",
    nextAction: "Preserve explicit operator commands but attach typed admission and delivery refs before command/broadcast emission.",
    currentDebt: "Goal lifecycle command envelopes and broadcasts can be emitted before the shared attention/delivery contract exists.",
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
    currentPreGateEffects: ["execute", "start_work", "enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "The /goals/:id/approve HTTP route emits an approval_response command envelope, resolves approval state, and broadcasts approval_resolved.",
    nextAction: "Carry approval responses through the feedback/permission/admission loop with pending-request refs before they can resume held work.",
    currentDebt: "Approval responses can resolve and resume held runtime work before the shared attention feedback/admission refs exist.",
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
    currentPreGateEffects: ["start_work", "enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "Schedule run-now posts a command envelope and broadcasts schedule_run_requested.",
    nextAction: "Route run-now command admission through the same explicit user-directed operation boundary used by schedule tools.",
    currentDebt: "Run-now command broadcast/envelope is accepted directly before the new shared delivery refs are attached.",
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
    currentPreGateEffects: ["enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "The /daemon/runtime-control HTTP route emits a runtime_control command envelope and runtime_control_requested broadcast.",
    nextAction: "Attach attention admission and delivery refs before runtime-control command emission and preserve executor approval/permission separation.",
    currentDebt: "Runtime-control command ingress can enqueue and broadcast operator-visible control requests before shared attention/delivery refs exist.",
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
    currentPreGateEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "POST /events accepts authorized events, may write event-spool files, and dispatcher handling can activate a referenced goal.",
    nextAction: "Convert HTTP events into replayable AttentionInput records before event-spool enqueue or goal activation.",
    currentDebt: "POST /events can enqueue event-spool records and activate goal-linked events before attention replay/admission is represented.",
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
    currentPreGateEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "File ingestion watches event-spool JSON files and dispatches parsed runtime events.",
    nextAction: "Treat ingested event files as replayable AttentionInput sources with source epoch and replay disposition.",
    currentDebt: "File ingestion can dispatch parsed goal-linked events that activate work before source replay is represented in the attention store.",
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
    currentPreGateEffects: ["notify", "enqueue", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "SSE broadcast can append outbox records and write externally visible event-stream frames.",
    nextAction: "Require admitted delivery projection refs on event-stream/outbox payloads except explicit operator diagnostic streams.",
    currentDebt: "SSE/outbox broadcast currently appends and emits events without admitted delivery projection refs.",
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
    currentPreGateEffects: ["speak", "execute", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: true,
    existingBehavior: "User-directed chat routes can emit assistant events and use approved tools through ChatRunner.",
    nextAction: "Keep ChatRunner as the turn engine, but carry admitted delivery refs through non-TUI surfaces after the shared delivery slice.",
    currentDebt: "Current direct ChatRunner event output does not yet carry the admitted delivery projection refs required by the shared delivery slice.",
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
