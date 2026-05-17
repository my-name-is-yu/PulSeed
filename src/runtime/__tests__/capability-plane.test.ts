import { describe, expect, it } from "vitest";
import { z } from "zod/v3";

import { descriptorFromTool } from "../capability-plane.js";
import type { ITool, ToolCallContext, ToolMetadata, ToolResult } from "../../tools/types.js";

describe("descriptorFromTool", () => {
  it("classifies mutating runtime-control tools before write-local file fallback", () => {
    const descriptor = descriptorFromTool(makeTool({
      name: "request_runtime_control",
      permissionLevel: "write_local",
      isReadOnly: false,
      tags: ["agentloop", "setup", "runtime-control"],
    }));

    expect(descriptor.capability_id).toBe("capability:runtime_control_action:request_runtime_control");
    expect(descriptor.provider_kind).toBe("runtime_control_action");
    expect(descriptor.provider_ref).toBe("runtime_control_action:request_runtime_control");
    expect(descriptor.authority_requirements.runtime_control_required).toBe(true);
  });
});

function makeTool(overrides: Partial<ToolMetadata>): ITool {
  const metadata: ToolMetadata = {
    name: "test_tool",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [],
    ...overrides,
  };
  return {
    metadata,
    inputSchema: z.unknown(),
    description: () => "test tool",
    call: async (_input: unknown, _context: ToolCallContext): Promise<ToolResult> => ({
      success: true,
      data: null,
      summary: "ok",
      durationMs: 0,
    }),
    checkPermissions: async () => ({ status: "allowed" }),
    isConcurrencySafe: () => true,
  };
}
