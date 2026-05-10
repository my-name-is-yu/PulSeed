import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  BrowserAutomationSessionRecordSchema,
  RuntimeAuthHandoffRecordSchema,
  RuntimeBudgetRecordSchema,
  RuntimeBudgetStore,
  RuntimeExperimentQueueRecordSchema,
  RuntimeExperimentQueueStore,
  RuntimeOperatorHandoffRecordSchema,
  RuntimeOperatorHandoffStore,
  saveRuntimeJson,
} from "../index.js";
import {
  CapabilityAuditRecordSchema,
  CapabilityVerificationRefSchema,
} from "../capability-verification-schemas.js";
import { CapabilityVerificationStore } from "../capability-verification-store.js";
import { importLegacyRuntimeFileState } from "../runtime-journal-state-migration.js";
import { BrowserSessionStore } from "../../interactive-automation/browser-session-store.js";
import { RuntimeAuthHandoffStore } from "../../interactive-automation/runtime-auth-handoff-store.js";
import {
  ProactiveInterventionActivityEventSchema,
  ProactiveInterventionStore,
} from "../proactive-intervention-store.js";

describe("importLegacyRuntimeFileState", () => {
  let baseDir: string;
  let runtimeRoot: string;

  beforeEach(() => {
    baseDir = makeTempDir("pulseed-runtime-file-state-migration-");
    runtimeRoot = path.join(baseDir, "runtime");
  });

  afterEach(() => {
    cleanupTempDir(baseDir);
  });

  it("imports old RuntimeJournal JSON and proactive JSONL only through the explicit migration boundary", async () => {
    await saveRuntimeJson(
      path.join(runtimeRoot, "operator-handoffs", "handoff-1.json"),
      RuntimeOperatorHandoffRecordSchema,
      {
        schema_version: "runtime-operator-handoff-v1",
        handoff_id: "handoff-1",
        goal_id: "goal-1",
        status: "open",
        triggers: ["auth"],
        title: "Auth needed",
        summary: "Login is required.",
        current_status: "blocked",
        recommended_action: "Complete login.",
        next_action: {
          label: "Login",
          approval_required: true,
        },
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z",
      },
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "budgets", "budget-1.json"),
      RuntimeBudgetRecordSchema,
      {
        schema_version: "runtime-budget-v1",
        budget_id: "budget-1",
        scope: { goal_id: "goal-1" },
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z",
        limits: [{ dimension: "iterations", limit: 3 }],
        usage: [{ dimension: "iterations", used: 1, updated_at: "2026-05-10T00:00:00.000Z", recent: [] }],
      },
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "experiment-queues", "queue-1.json"),
      RuntimeExperimentQueueRecordSchema,
      {
        schema_version: "runtime-experiment-queue-v1",
        queue_id: "queue-1",
        current_version: 1,
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z",
        revisions: [{
          version: 1,
          phase: "designing",
          status: "draft",
          revision_of: null,
          revision_reason: null,
          created_at: "2026-05-10T00:00:00.000Z",
          frozen_at: null,
          updated_at: "2026-05-10T00:00:00.000Z",
          provenance: { source: "legacy-test" },
          items: [],
        }],
      },
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "capability-verification", "verifications", "verify-1.json"),
      CapabilityVerificationRefSchema,
      capabilityVerification("verify-1"),
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "capability-verification", "audits", "audit-1.json"),
      CapabilityAuditRecordSchema,
      {
        schema_version: "capability-audit-record/v1",
        audit_id: "audit-1",
        operation_id: "operation-1",
        user_directed: true,
        initiated_by: "user",
        source_surface: "cli",
        result: "succeeded",
        side_effect_summary: "Read-only check.",
        user_visible_effect: "No visible change.",
        follow_up_policy_effect: "record_only",
        created_at: "2026-05-10T00:00:00.000Z",
      },
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "browser-sessions", "session-1.json"),
      BrowserAutomationSessionRecordSchema,
      {
        session_id: "session-1",
        provider_id: "browser",
        service_key: "app.example.com",
        workspace: "/workspace",
        actor_key: "chat-1",
        state: "authenticated",
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z",
      },
    );
    await saveRuntimeJson(
      path.join(runtimeRoot, "auth-handoffs", "auth-1.json"),
      RuntimeAuthHandoffRecordSchema,
      {
        schema_version: "runtime-auth-handoff-v1",
        handoff_id: "auth-1",
        provider_id: "browser",
        service_key: "app.example.com",
        workspace: "/workspace",
        actor_key: "chat-1",
        state: "pending_operator",
        requested_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z",
        resume_hint: {
          tool_name: "browser_run_workflow",
          task_summary: "Open app",
        },
      },
    );
    await fsp.mkdir(path.join(runtimeRoot, "proactive-interventions"), { recursive: true });
    await fsp.writeFile(
      path.join(runtimeRoot, "proactive-interventions", "events.jsonl"),
      `${JSON.stringify(ProactiveInterventionActivityEventSchema.parse({
        schema_version: "runtime-proactive-intervention-event-v1",
        event_id: "event-1",
        intervention_id: "intervention-1",
        recorded_at: "2026-05-10T00:00:00.000Z",
        channel: "daemon",
        event_type: "intervention",
        activity: {
          intervention_id: "intervention-1",
          kind: "suggestion",
          trigger: "proactive_tick",
          summary: "Suggested a task.",
          recorded_at: "2026-05-10T00:00:00.000Z",
        },
      }))}\n`,
      "utf8",
    );

    const report = await importLegacyRuntimeFileState({
      runtimeRootOrPaths: runtimeRoot,
      controlBaseDir: baseDir,
      importedAt: "2026-05-10T01:00:00.000Z",
    });

    expect(report).toMatchObject({
      operatorHandoffs: 1,
      budgets: 1,
      experimentQueues: 1,
      capabilityVerifications: 1,
      capabilityAudits: 1,
      browserSessions: 1,
      authHandoffs: 1,
      proactiveInterventionEvents: 1,
      invalidLegacyRecords: 0,
    });

    await fsp.rm(runtimeRoot, { recursive: true, force: true });

    await expect(new RuntimeOperatorHandoffStore(runtimeRoot).load("handoff-1")).resolves.toMatchObject({ handoff_id: "handoff-1" });
    await expect(new RuntimeBudgetStore(runtimeRoot).load("budget-1")).resolves.toMatchObject({ budget_id: "budget-1" });
    await expect(new RuntimeExperimentQueueStore(runtimeRoot).load("queue-1")).resolves.toMatchObject({ queue_id: "queue-1" });
    await expect(new CapabilityVerificationStore(runtimeRoot).loadVerification("verify-1")).resolves.toMatchObject({ verification_id: "verify-1" });
    await expect(new CapabilityVerificationStore(runtimeRoot).loadAudit("audit-1")).resolves.toMatchObject({ audit_id: "audit-1" });
    await expect(new BrowserSessionStore(runtimeRoot).load("session-1")).resolves.toMatchObject({ session_id: "session-1" });
    await expect(new RuntimeAuthHandoffStore(runtimeRoot).load("auth-1")).resolves.toMatchObject({ handoff_id: "auth-1" });
    await expect(new ProactiveInterventionStore(runtimeRoot).list()).resolves.toEqual([
      expect.objectContaining({ event_id: "event-1" }),
    ]);
    expect(report.legacyImports.map((record) => record.migration_name)).toEqual(
      Array.from({ length: 8 }, () => "runtime-journal-state"),
    );
  });

  it("marks malformed legacy RuntimeJournal sources blocked instead of silently dropping them", async () => {
    await fsp.mkdir(path.join(runtimeRoot, "budgets"), { recursive: true });
    await fsp.writeFile(path.join(runtimeRoot, "budgets", "bad.json"), "{}", "utf8");
    await fsp.mkdir(path.join(runtimeRoot, "proactive-interventions"), { recursive: true });
    await fsp.writeFile(path.join(runtimeRoot, "proactive-interventions", "events.jsonl"), "{}\n", "utf8");

    const blocked = await importLegacyRuntimeFileState({
      runtimeRootOrPaths: runtimeRoot,
      controlBaseDir: baseDir,
      importedAt: "2026-05-10T01:00:00.000Z",
    });

    expect(blocked.invalidLegacyRecords).toBe(2);
    expect(blocked.budgets).toBe(0);
    expect(blocked.proactiveInterventionEvents).toBe(0);
    expect(blocked.legacyImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_kind: "runtime-budget-json",
          status: "blocked",
          details: expect.objectContaining({
            invalid_count: 1,
            skipped_reason: "invalid_legacy_source",
          }),
        }),
        expect.objectContaining({
          source_kind: "proactive-intervention-jsonl",
          status: "blocked",
          details: expect.objectContaining({
            invalid_count: 1,
            skipped_reason: "invalid_legacy_source",
          }),
        }),
      ]),
    );

    await saveRuntimeJson(
      path.join(runtimeRoot, "budgets", "bad.json"),
      RuntimeBudgetRecordSchema,
      {
        schema_version: "runtime-budget-v1",
        budget_id: "budget-fixed",
        scope: { goal_id: "goal-fixed" },
        created_at: "2026-05-10T00:00:00.000Z",
        updated_at: "2026-05-10T00:00:00.000Z",
        limits: [{ dimension: "iterations", limit: 5 }],
        usage: [],
      },
    );
    await fsp.writeFile(
      path.join(runtimeRoot, "proactive-interventions", "events.jsonl"),
      `${JSON.stringify(ProactiveInterventionActivityEventSchema.parse({
        schema_version: "runtime-proactive-intervention-event-v1",
        event_id: "event-fixed",
        intervention_id: "intervention-fixed",
        recorded_at: "2026-05-10T00:00:00.000Z",
        channel: "daemon",
        event_type: "intervention",
        activity: {
          intervention_id: "intervention-fixed",
          kind: "suggestion",
          trigger: "proactive_tick",
          summary: "Suggested a corrected task.",
          recorded_at: "2026-05-10T00:00:00.000Z",
        },
      }))}\n`,
      "utf8",
    );

    const repaired = await importLegacyRuntimeFileState({
      runtimeRootOrPaths: runtimeRoot,
      controlBaseDir: baseDir,
      importedAt: "2026-05-10T02:00:00.000Z",
    });

    expect(repaired.invalidLegacyRecords).toBe(0);
    expect(repaired.budgets).toBe(1);
    expect(repaired.proactiveInterventionEvents).toBe(1);
    expect(repaired.legacyImports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_kind: "runtime-budget-json", status: "imported" }),
        expect.objectContaining({ source_kind: "proactive-intervention-jsonl", status: "imported" }),
      ]),
    );
    await expect(new RuntimeBudgetStore(runtimeRoot).load("budget-fixed")).resolves.toMatchObject({ budget_id: "budget-fixed" });
    await expect(new ProactiveInterventionStore(runtimeRoot).list()).resolves.toEqual([
      expect.objectContaining({ event_id: "event-fixed" }),
    ]);
  });
});

function capabilityVerification(verificationId: string) {
  return {
    schema_version: "capability-verification-ref/v1",
    verification_id: verificationId,
    provider_ref: "mcp:filesystem",
    asset_ref: "asset:mcp/filesystem",
    capability_id: "capability:mcp:filesystem:read_file",
    operation_kind: "read",
    tool_name: "read_file",
    payload_class: "path",
    risk_class: "low",
    side_effect_profile: "read",
    verification_class: "smoke_execution",
    result: "passed",
    evidence_stage: "smoke_verified",
    created_at: "2026-05-10T00:00:00.000Z",
  };
}
