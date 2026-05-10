import type { StateManager } from "../../base/state/state-manager.js";
import type { TriggerMapper } from "../trigger-mapper.js";
import type { ApprovalBroker, ApprovalRequiredEvent } from "../approval-broker.js";
import type { OutboxStore } from "../store/index.js";
import type { RuntimeSessionRegistrySnapshot } from "../session-registry/types.js";
import type { RuntimeOperatorHandoffRecord } from "../store/operator-handoff-store.js";
import type { RuntimeAutomationSnapshot } from "../store/index.js";

export interface EventServerConfig {
  host?: string;
  port?: number;
  eventsDir?: string;
  runtimeRoot?: string;
  controlBaseDir?: string;
  stateManager?: StateManager;
  triggerMapper?: TriggerMapper;
  approvalBroker?: ApprovalBroker;
  outboxStore?: OutboxStore;
  healthStatusProvider?: () => Record<string, unknown>;
  eventFileMaxAttempts?: number;
  eventFileRetryDelayMs?: number;
}

export interface EventServerSnapshot {
  daemon: Record<string, unknown> | null;
  goals: Array<{ id: string; title: string; status: string; loop_status: string }>;
  approvals: ApprovalRequiredEvent[];
  active_workers: Array<Record<string, unknown>>;
  last_outbox_seq: number;
  auth_sessions?: unknown[];
  guardrails?: Record<string, unknown> | null;
  runtime_automation?: RuntimeAutomationSnapshot;
  runtime_sessions?: RuntimeSessionRegistrySnapshot | null;
  operator_handoffs?: RuntimeOperatorHandoffRecord[];
}

export type ActiveWorkersProvider = () =>
  | Array<Record<string, unknown>>
  | Promise<Array<Record<string, unknown>>>;
