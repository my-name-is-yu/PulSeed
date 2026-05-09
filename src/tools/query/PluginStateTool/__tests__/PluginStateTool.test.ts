import { describe, expect, it } from "vitest";
import type { ToolCallContext } from "../../../types.js";
import type { PluginLoader } from "../../../../runtime/plugin-loader.js";
import { PluginStateTool } from "../PluginStateTool.js";

describe("PluginStateTool", () => {
  it("returns builtin integrations as non-executable asset evidence", async () => {
    const tool = new PluginStateTool({
      loadAll: async () => [],
    } as unknown as PluginLoader);

    const result = await tool.call({}, {} as ToolCallContext);

    expect(result.success).toBe(true);
    const data = result.data as {
      builtin_integration_assets: Array<{
        id: string;
        kind: string;
        status: string;
        execution: { executable: boolean; reason: string };
        metadata?: Record<string, unknown>;
      }>;
    };
    const mcpBridge = data.builtin_integration_assets.find((asset) =>
      asset.id === "builtin_integration:mcp-bridge"
    );
    expect(mcpBridge).toMatchObject({
      id: "builtin_integration:mcp-bridge",
      kind: "builtin_integration",
      status: "recorded",
      execution: {
        executable: false,
        reason: "asset_record_only",
      },
      metadata: {
        legacy_status: "available",
      },
    });
    expect(result.summary).toContain("builtin integration asset");
    expect(result.summary).not.toContain("status=available");
  });

  it("shows a single builtin integration through the asset view", async () => {
    const tool = new PluginStateTool({
      loadAll: async () => [],
    } as unknown as PluginLoader);

    const result = await tool.call({ pluginId: "mcp-bridge" }, {} as ToolCallContext);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      id: "builtin_integration:mcp-bridge",
      execution: {
        executable: false,
        reason: "asset_record_only",
      },
      metadata: {
        builtin_id: "mcp-bridge",
        legacy_status: "available",
      },
    });
    expect(result.summary).toBe(
      "Builtin integration asset builtin_integration:mcp-bridge: status=recorded, executable=false"
    );
  });
});
