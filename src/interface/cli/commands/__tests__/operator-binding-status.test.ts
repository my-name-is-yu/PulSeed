import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../../base/state/state-manager.js";
import { getGatewayChannelDir } from "../../../../base/utils/paths.js";
import { AssetRegistry } from "../../../../runtime/assets/registry.js";
import { projectCapabilityOperatorStatus } from "../../../../runtime/control/capability-status-projection.js";
import { CONTROL_DB_SCHEMA_VERSION, openControlDatabase } from "../../../../runtime/store/index.js";
import { CapabilityVerificationStore } from "../../../../runtime/store/capability-verification-store.js";
import { collectOperatorBindingStatus, printOperatorBindingStatus, type OperatorBindingStatus } from "../operator-binding-status.js";

const NOW = "2026-05-09T00:00:00.000Z";

describe("operator binding status capability runtime projection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects live capability runtime projections from asset graph and verification evidence", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-operator-capability-"));
    const stateManager = new StateManager(tmpDir);
    const runtimeRoot = path.join(tmpDir, "runtime");
    const assetId = "asset:notifier/slack";
    const capabilityId = "capability:notify.send";

    await new AssetRegistry({ baseDir: tmpDir }).record({
      id: assetId,
      kind: "notifier",
      label: "Slack notifier",
      source_agent: "pulseed",
      status: "recorded",
      metadata: {
        operation_contracts: [{
          id: "notify.send",
          operation_kind: "send",
          side_effect_profile: "send",
          privacy_profile: "external_service",
          risk_profile: "medium",
          reversibility: "irreversible",
          verification: {
            required: true,
            profile: "operation_specific_smoke",
          },
          authority_scope: "requires_runtime_selection",
          external_action_authority: true,
          payload_class: "notification_payload",
          required: [{
            kind: "config",
            ref: "notification_route:slack",
            reason: "Slack route must be configured.",
          }],
        }],
      },
    });

    const verificationStore = new CapabilityVerificationStore(runtimeRoot);
    await verificationStore.saveVerification({
      schema_version: "capability-verification-ref/v1",
      verification_id: "verify:notify-config",
      provider_ref: assetId,
      asset_ref: assetId,
      capability_id: capabilityId,
      operation_kind: "send",
      tool_name: "notify.send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      verification_class: "configuration_validation",
      result: "passed",
      evidence_stage: "configured",
      created_at: NOW,
      metadata: {},
    });
    await verificationStore.saveVerification({
      schema_version: "capability-verification-ref/v1",
      verification_id: "verify:notify-smoke",
      provider_ref: assetId,
      asset_ref: assetId,
      capability_id: capabilityId,
      operation_kind: "send",
      tool_name: "notify.send",
      payload_class: "notification_payload",
      risk_class: "medium",
      side_effect_profile: "send",
      verification_class: "smoke_execution",
      result: "passed",
      evidence_stage: "smoke_verified",
      created_at: NOW,
      metadata: {},
    });

    const status = await collectOperatorBindingStatus(stateManager);
    const projection = status.capability_runtime.find((item) =>
      item.capability_id === capabilityId && item.operation_id === "notify.send"
    );

    expect(projection).toMatchObject({
      provider_ref: assetId,
      readiness: {
        label: "execution_substrate_verified",
        can_execute: true,
        verification_refs: ["verify:notify-config", "verify:notify-smoke"],
      },
      admission: {
        label: "not_evaluated",
        allowed: false,
      },
      autonomy: {
        label: "not_evaluated",
        may_initiate_autonomously: false,
      },
      execution: {
        label: "execution_verified_admission_not_granted",
        can_execute: true,
        may_execute_now: false,
        may_initiate_autonomously: false,
      },
    });
  });

  it("marks configured gateway channels degraded when control DB schema is newer than this build", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-operator-schema-drift-"));
    const stateManager = new StateManager(tmpDir);
    const telegramConfigDir = getGatewayChannelDir("telegram-bot", tmpDir);
    fs.mkdirSync(telegramConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(telegramConfigDir, "config.json"),
      JSON.stringify({
        bot_token: "redacted-test-token",
        chat_id: 42,
        runtime_control_allowed_user_ids: [42],
        allowed_user_ids: [42],
        identity_key: "seedy",
      }),
      "utf-8"
    );
    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      database.transaction((db) => {
        db.pragma(`user_version = ${CONTROL_DB_SCHEMA_VERSION + 1}`);
      });
    } finally {
      database.close();
    }

    const status = await collectOperatorBindingStatus(stateManager);
    const telegram = status.channels.find((channel) => channel.name === "telegram-bot");

    expect(status.daemon.health).toBe("failed");
    expect(status.warnings.join("\n")).toContain("Control DB schema drift detected");
    expect(telegram).toMatchObject({
      configured: true,
      active: false,
      degraded: true,
      state: "degraded",
      health: {
        gateway: "failed",
        checked_at: null,
      },
      recent_health: {
        inbound_at: null,
        outbound_at: null,
        last_error: "unsupported_control_db_schema",
      },
    });
    expect(telegram?.warnings.join("\n")).toContain(`Database schema version ${CONTROL_DB_SCHEMA_VERSION + 1} is newer`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("prints explicit readiness, admission, autonomy, and execution labels without implying autonomy from readiness alone", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const capability = projectCapabilityOperatorStatus({
      readiness: {
        schema_version: "capability-readiness-snapshot/v1",
        snapshot_id: "readiness:notify:slack:send",
        capability_id: "capability:notify",
        provider_ref: "asset:notifier/slack",
        asset_ref: "asset:notifier/slack",
        operation_id: "notify.send",
        operation_kind: "send",
        tool_name: "notify.send",
        payload_class: "notification_payload",
        risk_class: "medium",
        side_effect_profile: "send",
        evaluated_at: NOW,
        state: "executable_verified",
        passed_gates: ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"],
        failed_gates: [],
        degraded_gates: [],
        missing_config_refs: [],
        missing_auth_refs: [],
        verification_refs: ["verify:notify"],
        evidence_refs: ["evidence:notify"],
        stale_refs: [],
        safe_user_visible_label: "Execution substrate verified",
        metadata: {},
      },
      registry_status: "available",
      evaluated_at: NOW,
    });
    const status: OperatorBindingStatus = {
      schema_version: "operator-binding-status-v1",
      generated_at: NOW,
      daemon: {
        running: true,
        port: 41701,
        health: "ok",
        runtime_root: "/tmp/pulseed-runtime",
      },
      channels: [],
      capability_runtime: [capability],
      sessions: [],
      background_runs: [],
      warnings: [],
    };

    printOperatorBindingStatus(status);

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Capability runtime:");
    expect(output).toContain("readiness=execution_substrate_verified");
    expect(output).toContain("admission=not_evaluated");
    expect(output).toContain("autonomy=not_evaluated");
    expect(output).toContain("execution=execution_verified_admission_not_granted");
    expect(output).toContain("can_execute=yes may_execute=no may_initiate=no");
    expect(output).toContain("Registry status available is evidence only");
  });
});
