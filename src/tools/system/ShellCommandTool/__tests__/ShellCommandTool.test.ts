import { describe, expect, it } from "vitest";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { ShellCommandInputSchema, ShellCommandTool } from "../ShellCommandTool.js";

describe("ShellCommandTool", () => {
  const tool = new ShellCommandTool();

  describe("input schema", () => {
    it("rejects invalid timeout controls", () => {
      expect(ShellCommandInputSchema.safeParse({ command: "echo ok", timeoutMs: 120_000 }).success).toBe(true);

      for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, 600_001]) {
        expect(ShellCommandInputSchema.safeParse({ command: "echo ok", timeoutMs }).success).toBe(false);
      }
    });

    it("exports timeout bounds to model-facing tool definitions", () => {
      const parameters = toToolDefinition(tool).function.parameters as {
        properties?: Record<string, unknown>;
      };

      expect(parameters.properties?.timeoutMs).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 600_000,
      });
    });
  });
});
