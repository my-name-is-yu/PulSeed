import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  LivingAutonomyDirectPathIds,
  LivingAutonomyDirectPathInventory,
  currentPreGateOutwardEffects,
  directPathInventoryById,
  forbiddenPreGateOutwardEffects,
  requiresAdmissionBeforeOutwardEffect,
} from "../direct-path-inventory.js";

function discoverGatewayChannelAdapterOwners(): string[] {
  const gatewayDir = path.join(process.cwd(), "src/runtime/gateway");
  return readdirSync(gatewayDir)
    .filter((fileName) => fileName.endsWith(".ts"))
    .filter((fileName) => {
      const filePath = path.join(gatewayDir, fileName);
      const source = readFileSync(filePath, "utf8");
      const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
      return sourceFile.statements.some((statement) =>
        ts.isClassDeclaration(statement) &&
        statement.heritageClauses?.some((clause) =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some((type) => type.expression.getText(sourceFile) === "ChannelAdapter")
        )
      );
    })
    .map((fileName) => `src/runtime/gateway/${fileName}`)
    .sort();
}

describe("LivingAutonomyDirectPathInventory", () => {
  it("classifies every source named in the non-GUI autonomy preflight", () => {
    const byId = directPathInventoryById();
    const entryIds = LivingAutonomyDirectPathInventory.map((entry) => entry.id);

    expect([...byId.keys()].sort()).toEqual([...LivingAutonomyDirectPathIds].sort());
    expect(LivingAutonomyDirectPathInventory).toHaveLength(LivingAutonomyDirectPathIds.length);
    expect(new Set(entryIds).size).toBe(entryIds.length);

    for (const entry of LivingAutonomyDirectPathInventory) {
      expect(entry.ownerModules.length).toBeGreaterThan(0);
      expect(entry.existingBehavior).not.toHaveLength(0);
      expect(entry.nextAction).not.toHaveLength(0);
    }
  });

  it("does not allow non-exception paths to produce outward effects before typed admission", () => {
    const nonExceptionPaths = LivingAutonomyDirectPathInventory.filter((entry) =>
      entry.classification !== "already_user_authorized_existing_behavior" &&
      entry.classification !== "explicitly_out_of_scope"
    );

    expect(nonExceptionPaths.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "notification.outbox",
    ]));
    for (const entry of nonExceptionPaths) {
      expect(entry.requiresTypedAdmission, entry.id).toBe(true);
      expect(forbiddenPreGateOutwardEffects(entry), entry.id).toEqual([]);
    }
  });

  it("keeps pre-gate outward effects limited to explicitly user-authorized schedule paths", () => {
    const entriesWithPreGateOutwardEffects = LivingAutonomyDirectPathInventory.filter((entry) =>
      forbiddenPreGateOutwardEffects({
        ...entry,
        classification: "convert_to_attention_operationplan_admission",
      }).length > 0
    );

    expect(entriesWithPreGateOutwardEffects.map((entry) => entry.id).sort()).toEqual([
      "schedule.cron_probe_notification",
      "schedule.goal_trigger",
    ]);
    for (const entry of entriesWithPreGateOutwardEffects) {
      expect(entry.classification, entry.id).toBe("already_user_authorized_existing_behavior");
    }
  });

  it("keeps user-authorized schedule execution separate from internal wake/admission paths", () => {
    const byId = directPathInventoryById();

    expect(byId.get("schedule.goal_trigger")).toMatchObject({
      classification: "already_user_authorized_existing_behavior",
      requiresTypedAdmission: false,
      preGateAllowedEffects: expect.arrayContaining(["start_work", "execute"]),
    });
    expect(byId.get("schedule.wait_resume")).toMatchObject({
      classification: "convert_to_attention_operationplan_admission",
      requiresTypedAdmission: true,
      preGateAllowedEffects: ["internal_signal", "quiet_audit"],
    });
  });

  it("marks every non-exception outward route as needing admission before it can speak, notify, enqueue, execute, or start work", () => {
    const pathsWithOutwardPotential = LivingAutonomyDirectPathInventory.filter((entry) =>
      requiresAdmissionBeforeOutwardEffect(entry)
    );

    expect(pathsWithOutwardPotential.map((entry) => entry.id).sort()).toEqual([
      "daemon.proactive_tick",
      "notification.outbox",
      "resident.curiosity",
      "resident.proactive_maintenance",
      "runtime_control.executor",
    ].sort());
    for (const entry of pathsWithOutwardPotential) {
      expect(entry.requiresTypedAdmission, entry.id).toBe(true);
    }
  });

  it("records no current direct outward effects for non-exception paths", () => {
    const currentOutwardPaths = LivingAutonomyDirectPathInventory.filter((entry) =>
      currentPreGateOutwardEffects(entry).length > 0
    );

    expect(currentOutwardPaths).toEqual([]);
  });

  it("keeps direct user-command and EventServer transports as explicit exception boundaries", () => {
    const byId = directPathInventoryById();
    const userAuthorizedCommandIds = [
      "event_server.command_approval_response",
      "event_server.command_goal_lifecycle",
      "event_server.command_runtime_control",
      "event_server.command_schedule_run_now",
      "gateway.outbound",
      "tui_chat_gateway.direct_route",
    ] as const;
    const outOfScopeTransportIds = [
      "event_server.file_ingestion",
      "event_server.post_events",
      "event_server.sse_outbox_broadcast",
      "event_server.trigger_create_task",
    ] as const;

    for (const id of userAuthorizedCommandIds) {
      expect(byId.get(id)).toMatchObject({
        classification: "already_user_authorized_existing_behavior",
        requiresTypedAdmission: false,
        exceptionBoundary: expect.any(String),
      });
    }
    for (const id of outOfScopeTransportIds) {
      expect(byId.get(id)).toMatchObject({
        classification: "explicitly_out_of_scope",
        requiresTypedAdmission: false,
        exceptionBoundary: expect.any(String),
      });
    }
  });

  it("keeps audited direct-path owner modules represented", () => {
    const ownerModules = new Set(
      LivingAutonomyDirectPathInventory.flatMap((entry) => entry.ownerModules)
    );

    expect([...ownerModules].sort()).toEqual(expect.arrayContaining([
      "src/runtime/event/server-trigger-handler.ts",
      "src/runtime/event/server.ts",
      "src/runtime/event/server-router.ts",
      "src/runtime/event/server-command-handler.ts",
      "src/runtime/event/server-file-ingestion.ts",
      "src/runtime/event/server-sse.ts",
      "src/runtime/event/dispatcher.ts",
      "src/runtime/command-dispatcher.ts",
      "src/runtime/gateway/http-channel-adapter.ts",
      "src/runtime/gateway/ws-channel-adapter.ts",
      "src/runtime/gateway/slack-channel-adapter.ts",
      "src/runtime/gateway/signal-gateway-adapter.ts",
      "src/runtime/gateway/discord-gateway-adapter.ts",
      "src/runtime/gateway/whatsapp-gateway-adapter.ts",
      "src/runtime/daemon/runner-resident-dream.ts",
    ]));
  });

  it("keeps every concrete gateway ChannelAdapter owner in the shared gateway path", () => {
    const gateway = directPathInventoryById().get("gateway.outbound");
    const expectedCurrentChannelAdapterOwners = [
      "src/runtime/gateway/http-channel-adapter.ts",
      "src/runtime/gateway/ws-channel-adapter.ts",
      "src/runtime/gateway/telegram-gateway-adapter.ts",
      "src/runtime/gateway/slack-channel-adapter.ts",
      "src/runtime/gateway/signal-gateway-adapter.ts",
      "src/runtime/gateway/discord-gateway-adapter.ts",
      "src/runtime/gateway/whatsapp-gateway-adapter.ts",
    ].sort();
    const concreteChannelAdapterOwners = discoverGatewayChannelAdapterOwners();

    expect(concreteChannelAdapterOwners).toEqual(expectedCurrentChannelAdapterOwners);
    expect(gateway?.ownerModules).toEqual(expect.arrayContaining(concreteChannelAdapterOwners));
  });

  it("pins EventServer HTTP routes that can enqueue, broadcast, execute, or start work", () => {
    const byId = directPathInventoryById();

    expect(byId.get("event_server.post_events")).toMatchObject({
      ownerModules: expect.arrayContaining([
        "src/runtime/event/server.ts",
        "src/runtime/event/server-router.ts",
        "src/runtime/event/dispatcher.ts",
        "src/platform/drive/drive-system.ts",
      ]),
      classification: "explicitly_out_of_scope",
      currentPreGateEffects: expect.arrayContaining(["internal_signal", "enqueue", "start_work"]),
      preGateAllowedEffects: ["internal_signal", "quiet_audit"],
      requiresTypedAdmission: false,
      exceptionBoundary: expect.any(String),
    });
    expect(byId.get("event_server.post_events")?.existingBehavior).toContain("POST /events");

    expect(byId.get("event_server.command_runtime_control")).toMatchObject({
      ownerModules: expect.arrayContaining([
        "src/runtime/event/server.ts",
        "src/runtime/event/server-router.ts",
        "src/runtime/event/server-command-handler.ts",
        "src/runtime/command-dispatcher.ts",
      ]),
      classification: "already_user_authorized_existing_behavior",
      currentPreGateEffects: expect.arrayContaining(["enqueue", "notify"]),
      preGateAllowedEffects: ["quiet_audit"],
      requiresTypedAdmission: false,
      exceptionBoundary: expect.any(String),
    });
    expect(byId.get("event_server.command_runtime_control")?.existingBehavior).toContain("/daemon/runtime-control");

    expect(byId.get("event_server.command_approval_response")).toMatchObject({
      ownerModules: expect.arrayContaining([
        "src/runtime/event/server.ts",
        "src/runtime/event/server-router.ts",
        "src/runtime/event/server-command-handler.ts",
        "src/runtime/command-dispatcher.ts",
      ]),
      classification: "already_user_authorized_existing_behavior",
      currentPreGateEffects: expect.arrayContaining(["enqueue", "notify", "execute", "start_work"]),
      preGateAllowedEffects: ["quiet_audit"],
      requiresTypedAdmission: false,
      exceptionBoundary: expect.any(String),
    });
    expect(byId.get("event_server.command_approval_response")?.existingBehavior).toContain("/goals/:id/approve");
    expect(byId.get("event_server.command_approval_response")?.existingBehavior).toContain("approval_response");
    expect(byId.get("event_server.command_approval_response")?.existingBehavior).toContain("approval_resolved");
  });

  it("pins trigger and file-ingested goal-linked events as EventServer transport exceptions", () => {
    const byId = directPathInventoryById();

    for (const id of ["event_server.trigger_create_task", "event_server.file_ingestion"] as const) {
      expect(byId.get(id)).toMatchObject({
        ownerModules: expect.arrayContaining(["src/runtime/event/dispatcher.ts"]),
        classification: "explicitly_out_of_scope",
        currentPreGateEffects: expect.arrayContaining(["internal_signal", "enqueue", "start_work"]),
        preGateAllowedEffects: ["internal_signal", "quiet_audit"],
        requiresTypedAdmission: false,
        exceptionBoundary: expect.any(String),
      });
      expect(byId.get(id)?.nextAction).toContain("EventServer");
    }
  });
});
