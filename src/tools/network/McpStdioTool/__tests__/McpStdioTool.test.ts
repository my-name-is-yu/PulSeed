import { describe, it, expect } from "vitest";
import { McpCallToolInputSchema, McpCallToolTool, McpListToolsInputSchema, McpListToolsTool } from "../McpStdioTool.js";

describe("MCP stdio tools", () => {
  it("requires approval before starting an MCP server for listing", async () => {
    const tool = new McpListToolsTool();
    const input = McpListToolsInputSchema.parse({ command: "node", args: ["server.js"] });
    const permission = await tool.checkPermissions(input);
    expect(permission.status).toBe("needs_approval");
  });

  it("requires approval before calling an MCP tool", async () => {
    const tool = new McpCallToolTool();
    const input = McpCallToolInputSchema.parse({
      command: "node",
      args: ["server.js"],
      tool_name: "external_tool",
      arguments: { value: 1 },
    });
    const permission = await tool.checkPermissions(input);
    expect(permission.status).toBe("needs_approval");
  });
});
