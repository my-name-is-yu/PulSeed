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
  exceptionBoundary?: string;
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
    classification: "already_user_authorized_existing_behavior",
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
    requiresTypedAdmission: false,
    existingBehavior: "Gateway adapters can render user-directed ChatRunner assistant events directly; autonomy-origin delivery uses the shared delivery projection and channel presence policy.",
    nextAction: "Keep resident/autonomy-origin delivery on the shared projection path; do not claim direct user chat output is an admitted resident initiative.",
    exceptionBoundary: "Direct gateway output is a response to user-directed ingress, not an agent-origin autonomous action.",
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
    classification: "explicitly_out_of_scope",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-trigger-handler.ts",
      "src/runtime/event/dispatcher.ts",
      "src/base/utils/event-spool.ts",
    ],
    possibleEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    currentPreGateEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "Trigger mappings can dispatch observed events or write create_task events into the event spool.",
    nextAction: "Handle EventServer trigger admission as a separate operator/IPC hardening slice; do not treat this path as closed by resident autonomy.",
    exceptionBoundary: "EventServer HTTP trigger handling is an authenticated operator/IPC event transport, not an agent-origin resident autonomy path.",
  },
  {
    id: "event_server.command_goal_lifecycle",
    label: "EventServer goal lifecycle commands",
    sourceAuthority: "user_directed_ingress",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/event/server-router.ts",
    ],
    possibleEffects: ["start_work", "execute", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["start_work", "enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "Goal start/stop/pause/resume/chat commands dispatch command envelopes and broadcast request events from explicit operator requests.",
    nextAction: "Preserve as explicit operator-command behavior; add a separate EventServer admission wrapper if operator HTTP transport is brought into the autonomy loop.",
    exceptionBoundary: "The outward effect is directly requested by an authenticated operator command, not initiated by resident autonomy.",
  },
  {
    id: "event_server.command_approval_response",
    label: "EventServer approval-response command",
    sourceAuthority: "user_directed_ingress",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-router.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/command-dispatcher.ts",
    ],
    possibleEffects: ["execute", "start_work", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["execute", "start_work", "enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "The /goals/:id/approve HTTP route emits an approval_response command envelope, resolves approval state, and broadcasts approval_resolved from an explicit approval response.",
    nextAction: "Preserve as explicit approval-response behavior; use feedback ingestion for resident correction/denial effects instead of adding a no-tool retry.",
    exceptionBoundary: "The outward effect resumes an already-held operator approval request, not an autonomous resident initiative.",
  },
  {
    id: "event_server.command_schedule_run_now",
    label: "EventServer schedule run-now command",
    sourceAuthority: "user_directed_ingress",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/schedule/engine-execution.ts",
    ],
    possibleEffects: ["start_work", "execute", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["start_work", "enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "Schedule run-now posts a command envelope and broadcasts schedule_run_requested from an explicit operator request.",
    nextAction: "Preserve as explicit operator-command behavior separate from resident initiative admission.",
    exceptionBoundary: "Run-now is a direct authenticated operator command, not an agent-origin wake or proactive action.",
  },
  {
    id: "event_server.command_runtime_control",
    label: "EventServer daemon runtime-control command",
    sourceAuthority: "user_directed_ingress",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-router.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/command-dispatcher.ts",
    ],
    possibleEffects: ["execute", "start_work", "enqueue", "notify", "quiet_audit"],
    currentPreGateEffects: ["enqueue", "notify", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "The /daemon/runtime-control HTTP route emits a runtime_control command envelope and runtime_control_requested broadcast from an explicit operator request.",
    nextAction: "Keep runtime-control executor approval/permission separation; wrap EventServer transport separately if operator HTTP command ingress is brought into attention.",
    exceptionBoundary: "Runtime-control HTTP ingress is an authenticated operator command envelope; executor authority remains separately gated.",
  },
  {
    id: "event_server.post_events",
    label: "EventServer POST /events external event ingress",
    sourceAuthority: "user_directed_ingress",
    classification: "explicitly_out_of_scope",
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
    requiresTypedAdmission: false,
    existingBehavior: "POST /events accepts authorized events, may write event-spool files, and dispatcher handling can activate a referenced goal.",
    nextAction: "Handle EventServer POST /events admission as a separate authenticated event-transport hardening slice.",
    exceptionBoundary: "EventServer POST /events is an authenticated external event ingress transport outside the resident autonomy loop implemented by this goal.",
  },
  {
    id: "event_server.file_ingestion",
    label: "EventServer file-ingestion event spool",
    sourceAuthority: "runtime_internal",
    classification: "explicitly_out_of_scope",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-file-ingestion.ts",
      "src/runtime/event/dispatcher.ts",
      "src/base/utils/event-spool.ts",
    ],
    possibleEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    currentPreGateEffects: ["internal_signal", "enqueue", "start_work", "quiet_audit"],
    preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "File ingestion watches event-spool JSON files and dispatches parsed runtime events.",
    nextAction: "Handle event-spool admission/replay as a separate EventServer transport hardening slice.",
    exceptionBoundary: "Event-spool file ingestion is a bounded IPC/spool transport outside the resident autonomy loop implemented by this goal.",
  },
  {
    id: "event_server.sse_outbox_broadcast",
    label: "EventServer SSE and outbox broadcast",
    sourceAuthority: "runtime_internal",
    classification: "explicitly_out_of_scope",
    ownerModules: [
      "src/runtime/event/server.ts",
      "src/runtime/event/server-sse.ts",
      "src/runtime/store/outbox-store.ts",
    ],
    possibleEffects: ["notify", "enqueue", "quiet_audit"],
    currentPreGateEffects: ["notify", "enqueue", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "SSE broadcast can append outbox records and write externally visible event-stream frames.",
    nextAction: "Handle SSE/outbox delivery admission as a separate EventServer operator-stream hardening slice.",
    exceptionBoundary: "EventServer SSE/outbox is an operator diagnostic/event stream transport outside the resident autonomy loop implemented by this goal.",
  },
  {
    id: "tui_chat_gateway.direct_route",
    label: "TUI/chat/gateway direct ChatRunner route",
    sourceAuthority: "user_directed_ingress",
    classification: "already_user_authorized_existing_behavior",
    ownerModules: [
      "src/interface/chat/chat-runner.ts",
      "src/interface/chat/chat-runner-routes.ts",
      "src/interface/tui/chat.tsx",
    ],
    possibleEffects: ["speak", "execute", "quiet_audit"],
    currentPreGateEffects: ["speak", "execute", "quiet_audit"],
    preGateAllowedEffects: ["quiet_audit"],
    requiresTypedAdmission: false,
    existingBehavior: "User-directed chat routes keep ChatRunner as the turn engine and may emit assistant/tool events directly for the active user turn.",
    nextAction: "Preserve ChatRunner as the turn engine; require shared delivery projection for resident/autonomy-origin outputs rather than direct user replies.",
    exceptionBoundary: "Direct TUI/chat output is a response to user-directed ingress and approved tool policy, not an agent-origin autonomous action.",
  },
] as const;

export function directPathInventoryById(): Map<LivingAutonomyDirectPathId, LivingAutonomyDirectPathInventoryEntry> {
  return new Map(LivingAutonomyDirectPathInventory.map((entry) => [entry.id, entry]));
}

export function requiresAdmissionBeforeOutwardEffect(entry: LivingAutonomyDirectPathInventoryEntry): boolean {
  if (
    entry.classification === "already_user_authorized_existing_behavior" ||
    entry.classification === "explicitly_out_of_scope"
  ) return false;
  return entry.possibleEffects.some((effect) => outwardEffects.includes(effect));
}

export function forbiddenPreGateOutwardEffects(entry: LivingAutonomyDirectPathInventoryEntry): LivingAutonomyEffect[] {
  if (
    entry.classification === "already_user_authorized_existing_behavior" ||
    entry.classification === "explicitly_out_of_scope"
  ) return [];
  return entry.preGateAllowedEffects.filter((effect) => outwardEffects.includes(effect));
}

export function currentPreGateOutwardEffects(entry: LivingAutonomyDirectPathInventoryEntry): LivingAutonomyEffect[] {
  if (
    entry.classification === "already_user_authorized_existing_behavior" ||
    entry.classification === "explicitly_out_of_scope"
  ) return [];
  return entry.currentPreGateEffects.filter((effect) => outwardEffects.includes(effect));
}
