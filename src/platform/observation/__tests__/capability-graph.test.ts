import { describe, expect, it } from "vitest";
import {
  buildCompanionCapabilityGraph,
  listCompanionCapabilityGraphExamples,
} from "../capability-graph.js";
import {
  createAssetRecord,
  toAssetView,
  type AssetKind,
  type AssetView,
} from "../../../runtime/assets/types.js";
import type { CapabilityOperationContract } from "../types/capability.js";

function asset(kind: AssetKind, id: string, metadata: Record<string, unknown> = {}): AssetView {
  return toAssetView(createAssetRecord({
    id,
    kind,
    label: id,
    source_agent: "pulseed",
    status: "recorded",
    metadata,
  }, "2026-05-09T00:00:00.000Z"));
}

function contract(id: string): CapabilityOperationContract {
  return {
    id,
    operation_kind: "read",
    side_effect_profile: "read",
    privacy_profile: "workspace_private",
    risk_profile: "low",
    reversibility: "reversible",
    verification: {
      required: true,
      profile: "operation_specific_smoke",
    },
    authority_scope: "requires_runtime_selection",
    external_action_authority: false,
    payload_class: "test_payload",
    required: [],
  };
}

describe("companion capability graph", () => {
  it("creates asset-backed candidates only when an explicit operation contract exists", () => {
    const graph = buildCompanionCapabilityGraph({
      generatedAt: "2026-05-09T00:00:00.000Z",
      assets: [
        asset("skill_bundle", "asset:skill/no-contract"),
        asset("mcp_server", "asset:mcp/with-contract", {
          operation_contracts: [contract("filesystem_read")],
        }),
      ],
    });

    expect(graph.candidates.map((candidate) => candidate.id)).toEqual(["capability:filesystem_read"]);
    expect(graph.candidates[0]?.providers).toMatchObject([{
      provider_kind: "mcp_server",
      asset_id: "asset:mcp/with-contract",
    }]);
    expect(graph.candidates[0]?.operations[0]?.required).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "asset",
        ref: "asset:mcp/with-contract",
      }),
    ]));
  });

  it("merges multiple providers for the same explicit capability candidate", () => {
    const graph = buildCompanionCapabilityGraph({
      assets: [
        asset("mcp_server", "asset:mcp/a", {
          operation_contracts: [contract("shared_read")],
        }),
        asset("runtime_tool", "asset:tool/b", {
          operation_contracts: [contract("shared_read")],
        }),
      ],
    });

    expect(graph.candidates).toHaveLength(1);
    expect(graph.candidates[0]?.providers.map((provider) => provider.provider_id).sort()).toEqual([
      "asset:mcp/a",
      "asset:tool/b",
    ]);
  });

  it("projects Dream procedural hints as planning hints without execution authority", () => {
    const graph = buildCompanionCapabilityGraph({
      assets: [asset("dream_procedural_hint", "asset:dream/playbook", {
        operation_contracts: [{
          ...contract("unsafe_dream_send"),
          operation_kind: "send",
          side_effect_profile: "send",
          privacy_profile: "external_service",
          authority_scope: "requires_runtime_selection",
          external_action_authority: true,
          payload_class: "notification_payload",
        }],
      })],
    });

    const candidate = graph.candidates.find((item) => item.id === "capability:dream_procedural_hint_use");
    expect(candidate).toBeDefined();
    expect(candidate?.operations[0]).toMatchObject({
      operation_kind: "hint",
      side_effect_profile: "none",
      authority_scope: "planning_hint_only",
      external_action_authority: false,
      verification: {
        required: false,
        profile: "none",
      },
    });
    expect(candidate?.metadata).toMatchObject({
      planning_hint_only: true,
      execution_authority: false,
      ignored_operation_contracts: 1,
    });
    expect(graph.candidates.find((item) => item.id === "capability:unsafe_dream_send")).toBeUndefined();
  });

  it("projects Soil and Knowledge surfaces without external-action authority", () => {
    const graph = buildCompanionCapabilityGraph({
      assets: [
        asset("soil_surface", "asset:soil/search", {
          operation_contracts: [{
            ...contract("unsafe_soil_publish"),
            operation_kind: "publish",
            side_effect_profile: "publish",
            privacy_profile: "external_service",
            authority_scope: "requires_runtime_selection",
            external_action_authority: true,
          }],
        }),
        asset("knowledge_surface", "asset:knowledge/search", {
          operation_contracts: [{
            ...contract("unsafe_knowledge_write"),
            operation_kind: "write",
            side_effect_profile: "write",
            authority_scope: "requires_runtime_selection",
            external_action_authority: true,
          }],
        }),
      ],
    });

    const soil = graph.candidates.find((item) => item.id === "capability:soil_query");
    const knowledge = graph.candidates.find((item) => item.id === "capability:knowledge_search");
    expect(soil?.operations[0]).toMatchObject({
      authority_scope: "internal_knowledge_only",
      external_action_authority: false,
      side_effect_profile: "read",
    });
    expect(knowledge?.operations[0]).toMatchObject({
      authority_scope: "internal_knowledge_only",
      external_action_authority: false,
      side_effect_profile: "read",
    });
    expect(graph.candidates.find((item) => item.id === "capability:unsafe_soil_publish")).toBeUndefined();
    expect(graph.candidates.find((item) => item.id === "capability:unsafe_knowledge_write")).toBeUndefined();
  });

  it("projects loaded plugin candidates with policy metadata requirements instead of loader state alone", () => {
    const graph = buildCompanionCapabilityGraph({
      pluginStates: [{
        name: "slack-notifier",
        manifest: {
          name: "slack-notifier",
          version: "1.0.0",
          type: "notifier",
          capabilities: ["send_slack_notification"],
          description: "Slack notifier",
          config_schema: {},
          dependencies: [],
          entry_point: "dist/index.js",
          permissions: {
            network: true,
            file_read: false,
            file_write: false,
            shell: false,
          },
        },
        status: "loaded",
        loaded_at: "2026-05-09T00:00:00.000Z",
        trust_score: 0,
        usage_count: 0,
        success_count: 0,
        failure_count: 0,
      }],
    });

    const candidate = graph.candidates.find((item) => item.id === "capability:send_slack_notification");
    expect(candidate?.operations[0]).toMatchObject({
      operation_kind: "send",
      side_effect_profile: "send",
      external_action_authority: true,
      verification: {
        required: true,
        profile: "operation_specific_smoke",
      },
    });
    expect(candidate?.operations[0]?.required).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "runtime_state", ref: "plugin_loader:slack-notifier:loaded" }),
      expect.objectContaining({ kind: "config", ref: "plugin:slack-notifier:config" }),
      expect.objectContaining({ kind: "admission", ref: "runtime_control:admission" }),
      expect.objectContaining({ kind: "permission", ref: "plugin:slack-notifier:permissions" }),
      expect.objectContaining({ kind: "verification", ref: "plugin:slack-notifier:notifier" }),
    ]));
  });

  it("keeps MCP tool mappings operation-specific capability candidates", () => {
    const graph = buildCompanionCapabilityGraph({
      mcpServers: [{
        id: "openclaw-filesystem",
        name: "Filesystem",
        transport: "stdio",
        command: "node",
        tool_mappings: [{
          tool_name: "read_file",
          dimension_pattern: "filesystem_*",
        }],
        enabled: false,
      }],
    });

    const candidate = graph.candidates.find((item) => item.id === "capability:mcp:openclaw-filesystem:read_file");
    expect(candidate?.operations[0]).toMatchObject({
      operation_kind: "read",
      side_effect_profile: "read",
      verification: {
        required: true,
        profile: "operation_specific_smoke",
      },
      external_action_authority: false,
    });
    expect(candidate?.operations[0]?.required.map((item) => item.kind)).toEqual([
      "config",
      "auth",
      "verification",
    ]);
  });

  it("exposes design graph examples without turning normal UX into a catalog", () => {
    const graph = listCompanionCapabilityGraphExamples("2026-05-09T00:00:00.000Z");
    const ids = graph.candidates.map((candidate) => candidate.id).sort();

    expect(ids).toEqual([
      "capability:dream_procedural_hint_use",
      "capability:knowledge_search",
      "capability:run_browser_workflow",
      "capability:send_slack_notification",
      "capability:soil_query",
    ]);
    expect(graph.dependency_edges.some((edge) =>
      edge.from === "capability:send_slack_notification"
      && edge.to === "admission:notification_route"
    )).toBe(true);
    expect(graph.candidates.find((candidate) => candidate.id === "capability:dream_procedural_hint_use")?.operations[0])
      .toMatchObject({
        authority_scope: "planning_hint_only",
        external_action_authority: false,
      });
  });
});
