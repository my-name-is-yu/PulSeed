import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";

const MAX_OUTPUT_CHARS = 20_000;

const McpServerProcessSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  env: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});

export const McpListToolsInputSchema = McpServerProcessSchema;
export type McpListToolsInput = z.infer<typeof McpListToolsInputSchema>;

export const McpCallToolInputSchema = McpServerProcessSchema.extend({
  tool_name: z.string().min(1),
  arguments: z.record(z.unknown()).default({}),
});
export type McpCallToolInput = z.infer<typeof McpCallToolInputSchema>;

export class McpListToolsTool implements ITool<McpListToolsInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "mcp_list_tools",
    aliases: ["list_mcp_tools"],
    permissionLevel: "read_metrics",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 2,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: ["mcp", "tool", "external", "agentloop"],
  };

  readonly inputSchema = McpListToolsInputSchema;

  description(): string {
    return "Start an MCP stdio server process, list its tools, then close it.";
  }

  async call(input: McpListToolsInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const data = await withMcpClient(input, context.cwd, async (client) => client.listTools({}, { timeout: input.timeoutMs }));
      return {
        success: true,
        data,
        summary: `Listed ${(data as { tools?: unknown[] }).tools?.length ?? 0} MCP tool(s)`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return failureResult(`MCP list tools failed: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(_input: McpListToolsInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: "Listing MCP tools starts an external server process." };
  }

  isConcurrencySafe(_input: McpListToolsInput): boolean {
    return true;
  }
}

export class McpCallToolTool implements ITool<McpCallToolInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "mcp_call_tool",
    aliases: ["call_mcp_tool"],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: ["mcp", "tool", "external", "agentloop"],
  };

  readonly inputSchema = McpCallToolInputSchema;

  description(): string {
    return "Start an MCP stdio server process, call one tool, then close it. The called tool may have side effects.";
  }

  async call(input: McpCallToolInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const data = await withMcpClient(input, context.cwd, async (client) =>
        client.callTool({ name: input.tool_name, arguments: input.arguments }, undefined, { timeout: input.timeoutMs })
      );
      return {
        success: true,
        data,
        summary: `MCP tool ${input.tool_name} completed`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return failureResult(`MCP tool ${input.tool_name} failed: ${(err as Error).message}`, startTime);
    }
  }

  async checkPermissions(input: McpCallToolInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: `Calling MCP tool ${input.tool_name} can change external state.` };
  }

  isConcurrencySafe(_input: McpCallToolInput): boolean {
    return false;
  }
}

async function withMcpClient<T>(
  input: McpListToolsInput,
  defaultCwd: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: input.command,
    args: input.args,
    cwd: input.cwd ?? defaultCwd,
    env: input.env ? { ...getDefaultEnvironment(), ...input.env } : undefined,
    stderr: "pipe",
  });
  const client = new Client({ name: "pulseed-mcp-bridge", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: input.timeoutMs });
    return await fn(client);
  } finally {
    await transport.close().catch(() => undefined);
  }
}

function failureResult(message: string, startTime: number): ToolResult {
  return {
    success: false,
    data: null,
    summary: message,
    error: message,
    durationMs: Date.now() - startTime,
  };
}
