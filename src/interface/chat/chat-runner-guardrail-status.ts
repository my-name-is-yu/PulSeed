import * as path from "node:path";

import type { StateManager } from "../../base/state/state-manager.js";
import type { DaemonSnapshot } from "../../runtime/daemon/client.js";
import { BrowserSessionStore } from "../../runtime/interactive-automation/index.js";
import { GuardrailStore } from "../../runtime/guardrails/index.js";
import {
  RuntimeOperatorHandoffStore,
  type RuntimeOperatorHandoffRecord,
} from "../../runtime/store/operator-handoff-store.js";
import { RuntimeBudgetStore } from "../../runtime/store/budget-store.js";
import {
  createRuntimeBudgetProjections,
  type RuntimeBudgetProjection,
} from "../runtime-budget-summary.js";

interface RuntimeGuardrailSummary {
  openBreakers: Array<Record<string, unknown>>;
  backpressureActiveCount: number;
  blockedWork: Array<Record<string, unknown>>;
}

export async function loadOpenOperatorHandoffsFromRuntime(
  stateManager: StateManager
): Promise<RuntimeOperatorHandoffRecord[]> {
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  return new RuntimeOperatorHandoffStore(runtimeRoot).listOpen();
}

export async function loadRuntimeBudgetsFromRuntime(
  stateManager: StateManager
): Promise<RuntimeBudgetProjection[]> {
  try {
    const store = new RuntimeBudgetStore(path.join(stateManager.getBaseDir(), "runtime"));
    return createRuntimeBudgetProjections(store, await store.list());
  } catch {
    return [];
  }
}

export async function formatGuardrailStatus(input: {
  stateManager: StateManager;
  snapshot?: DaemonSnapshot | null;
  diagnostic?: boolean;
}): Promise<string | null> {
  const automation = input.snapshot?.runtime_automation && typeof input.snapshot.runtime_automation === "object"
    ? input.snapshot.runtime_automation as Record<string, unknown>
    : null;
  const remoteAuthSessions = Array.isArray(input.snapshot?.auth_sessions) ? input.snapshot.auth_sessions : null;
  const remoteGuardrails = input.snapshot?.guardrails && typeof input.snapshot.guardrails === "object"
    ? input.snapshot.guardrails
    : null;
  const remoteOperatorHandoffs = Array.isArray(input.snapshot?.operator_handoffs)
    ? input.snapshot.operator_handoffs
    : null;
  const typedAuthHandoffs = extractPendingAuthFromAutomation(automation);
  const pendingAuth = typedAuthHandoffs.length > 0
    ? typedAuthHandoffs
    : remoteAuthSessions ?? await loadPendingAuthSessionsFromRuntime(input.stateManager);
  const operatorHandoffs = remoteOperatorHandoffs ?? await loadOpenOperatorHandoffsFromRuntime(input.stateManager);
  const automationSummary = extractAutomationSummaryFromSnapshot(automation);
  const fallbackSummary = remoteGuardrails
    ? extractGuardrailSummaryFromSnapshot(remoteGuardrails)
    : await loadGuardrailsFromRuntime(input.stateManager);
  const openBreakers = automationSummary.openBreakers.length > 0 ? automationSummary.openBreakers : fallbackSummary.openBreakers;
  const backpressureActiveCount = automationSummary.backpressureActiveCount > 0
    ? automationSummary.backpressureActiveCount
    : fallbackSummary.backpressureActiveCount;
  const blockedWork = automationSummary.blockedWork.length > 0 ? automationSummary.blockedWork : fallbackSummary.blockedWork;
  const lines: string[] = [];
  if (operatorHandoffs.length > 0) {
    lines.push("Operator handoffs pending:");
    for (const handoff of operatorHandoffs.slice(0, 5)) {
      const record = handoff as Record<string, unknown>;
      const triggers = Array.isArray(record["triggers"]) ? record["triggers"].join(",") : "unknown";
      if (input.diagnostic) {
        lines.push(`- ${String(record["title"] ?? record["handoff_id"] ?? "handoff")} [${triggers}] ${String(record["recommended_action"] ?? "")}`);
      } else {
        lines.push(`- ${String(record["title"] ?? "Operator review")} - ${String(record["recommended_action"] ?? "Review the pending handoff.")}`);
      }
    }
  }
  if (pendingAuth.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Auth handoffs pending:");
    for (const session of pendingAuth.slice(0, 5)) {
      const record = session as Record<string, unknown>;
      if (input.diagnostic) {
        lines.push(`- ${String(record["service_key"] ?? "unknown")} via ${String(record["provider_id"] ?? "unknown")} [${String(record["state"] ?? "unknown")}] handoff ${String(record["handoff_id"] ?? record["session_id"] ?? "unknown")}`);
      } else {
        lines.push(`- ${String(record["service_key"] ?? "unknown service")} via ${String(record["provider_id"] ?? "unknown provider")} is waiting for operator sign-in.`);
      }
    }
  }
  if (openBreakers.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Guardrails:");
    for (const breaker of openBreakers.slice(0, 5)) {
      const record = breaker as Record<string, unknown>;
      if (input.diagnostic) {
        lines.push(`- breaker ${String(record["provider_id"] ?? "unknown")}/${String(record["service_key"] ?? "unknown")}: ${String(record["state"] ?? "unknown")} (failures ${String(record["failure_count"] ?? "0")})`);
      } else {
        lines.push(`- ${String(record["provider_id"] ?? "unknown provider")}/${String(record["service_key"] ?? "unknown service")} is temporarily paused after ${String(record["failure_count"] ?? "0")} failure(s).`);
      }
    }
  }
  if (backpressureActiveCount > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Backpressure active: ${backpressureActiveCount} browser workflow(s) in flight`);
  }
  if (blockedWork.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Blocked automation work:");
    for (const blocked of blockedWork.slice(0, 5)) {
      const record = blocked as Record<string, unknown>;
      if (input.diagnostic) {
        lines.push(`- ${String(record["provider_id"] ?? "unknown")}/${String(record["service_key"] ?? "unknown")}: ${String(record["reason"] ?? "blocked")}`);
      } else {
        lines.push(`- ${String(record["provider_id"] ?? "unknown provider")}/${String(record["service_key"] ?? "unknown service")} is waiting for the automation guardrail to clear.`);
      }
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

async function loadPendingAuthSessionsFromRuntime(stateManager: StateManager): Promise<Array<Record<string, unknown>>> {
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  return new BrowserSessionStore(runtimeRoot).listPendingAuth() as Promise<Array<Record<string, unknown>>>;
}

async function loadGuardrailsFromRuntime(stateManager: StateManager): Promise<RuntimeGuardrailSummary> {
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  const [breakers, backpressure] = await Promise.all([
    new GuardrailStore(runtimeRoot).listBreakers(),
    new GuardrailStore(runtimeRoot).loadBackpressureSnapshot(),
  ]);
  return {
    openBreakers: breakers.filter((breaker) =>
      breaker.state === "open" || breaker.state === "paused" || breaker.state === "half_open"
    ) as Array<Record<string, unknown>>,
    backpressureActiveCount: backpressure?.active.length ?? 0,
    blockedWork: [],
  };
}

function extractGuardrailSummaryFromSnapshot(guardrails: Record<string, unknown>): RuntimeGuardrailSummary {
  const openBreakers = Array.isArray(guardrails["open_breakers"])
    ? guardrails["open_breakers"].filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  const backpressureActiveCount = Array.isArray(guardrails["backpressure_active"])
    ? guardrails["backpressure_active"].length
    : 0;
  return { openBreakers, backpressureActiveCount, blockedWork: [] };
}

function extractPendingAuthFromAutomation(automation: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!automation) return [];
  const authHandoffs = automation["auth_handoffs"];
  if (!authHandoffs || typeof authHandoffs !== "object") return [];
  const record = authHandoffs as Record<string, unknown>;
  return Array.isArray(record["pending"])
    ? record["pending"].filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function extractAutomationSummaryFromSnapshot(automation: Record<string, unknown> | null): RuntimeGuardrailSummary {
  if (!automation) return { openBreakers: [], backpressureActiveCount: 0, blockedWork: [] };
  const guardrails = automation["guardrails"];
  const guardrailRecord = guardrails && typeof guardrails === "object" ? guardrails as Record<string, unknown> : {};
  const backpressure = automation["backpressure"];
  const backpressureRecord = backpressure && typeof backpressure === "object" ? backpressure as Record<string, unknown> : {};
  return {
    openBreakers: Array.isArray(guardrailRecord["open_breakers"])
      ? guardrailRecord["open_breakers"].filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      : Array.isArray(guardrailRecord["paused_breakers"]) || Array.isArray(guardrailRecord["half_open_breakers"])
        ? [
          ...(Array.isArray(guardrailRecord["paused_breakers"]) ? guardrailRecord["paused_breakers"] : []),
          ...(Array.isArray(guardrailRecord["half_open_breakers"]) ? guardrailRecord["half_open_breakers"] : []),
        ].filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
        : [],
    backpressureActiveCount: Array.isArray(backpressureRecord["active"])
      ? backpressureRecord["active"].length
      : 0,
    blockedWork: Array.isArray(automation["blocked_work"])
      ? automation["blocked_work"].filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      : [],
  };
}
