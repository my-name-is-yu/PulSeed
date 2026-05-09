import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../../base/state/state-manager.js";
import { AssetRegistry } from "../assets/registry.js";
import { createCapabilityExecutionResolver } from "../capability-execution-resolver.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    cleanupTempDir(root);
  }
});

describe("createCapabilityExecutionResolver", () => {
  it("binds a production tool call to the matching capability operation contract", async () => {
    const baseDir = makeTempDir("pulseed-capability-execution-resolver-");
    roots.push(baseDir);
    const stateManager = new StateManager(baseDir);
    await new AssetRegistry({ baseDir }).record({
      id: "asset:runtime/workspace-status",
      kind: "runtime_tool",
      label: "Workspace status",
      source_agent: "pulseed",
      status: "recorded",
      metadata: {
        operation_contracts: [{
          id: "workspace_status",
          operation_kind: "read",
          side_effect_profile: "read",
          privacy_profile: "workspace_private",
          risk_profile: "low",
          reversibility: "reversible",
          authority_scope: "requires_runtime_selection",
          external_action_authority: false,
          payload_class: "workspace_status_payload",
          verification: {
            required: true,
            profile: "operation_specific_smoke",
          },
          required: [],
        }],
      },
    });

    const resolver = createCapabilityExecutionResolver({
      stateManager,
      generatedAt: () => "2026-05-09T00:00:00.000Z",
    });

    await expect(resolver({
      toolName: "workspace_status",
      toolMetadata: {
        name: "workspace_status",
        aliases: [],
        permissionLevel: "read_only",
        isReadOnly: true,
        isDestructive: false,
        shouldDefer: false,
        alwaysLoad: false,
        maxConcurrency: 0,
        maxOutputChars: 8000,
        tags: [],
        activityCategory: "read",
      },
      rawInput: {},
      operationKind: "read",
      payloadClass: "tool-input:workspace_status",
      riskClass: "low",
      sideEffectProfile: "read",
    })).resolves.toEqual(expect.objectContaining({
      operationId: "workspace_status",
      providerRef: "asset:runtime/workspace-status",
      assetRef: "asset:runtime/workspace-status",
      capabilityId: "capability:workspace_status",
      operationKind: "read",
      toolName: "workspace_status",
      payloadClass: "workspace_status_payload",
      riskClass: "low",
      sideEffectProfile: "read",
      readinessSnapshotRefs: ["readiness:capability:workspace_status:asset:runtime/workspace-status:workspace_status"],
    }));
  });
});
