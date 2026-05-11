import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toToolDefinition } from "../tool-definition-adapter.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../types.js";

function makeTool(inputSchema: z.ZodTypeAny): ITool {
  const metadata: ToolMetadata = {
    name: "schema_probe",
    aliases: [],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 1_000,
    tags: ["test"],
  };

  return {
    metadata,
    inputSchema,
    description: () => "Probe tool schema conversion.",
    call: async (_input: unknown, _context: ToolCallContext): Promise<ToolResult> => ({
      success: true,
      data: {},
      summary: "ok",
      durationMs: 0,
    }),
    checkPermissions: async (_input: unknown, _context: ToolCallContext): Promise<PermissionCheckResult> => ({
      status: "allowed",
    }),
    isConcurrencySafe: () => true,
  };
}

describe("toToolDefinition", () => {
  it("exports standard JSON Schema numeric exclusive bounds for safe number inputs", () => {
    const inputSchema = z.object({
      positiveCount: z.number().int().positive().safe(),
      negativeRatio: z.number().negative().safe().optional(),
    }).strict();

    const parameters = toToolDefinition(makeTool(inputSchema)).function.parameters as {
      $schema?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(parameters.$schema).toBeUndefined();
    expect(parameters.properties?.positiveCount).toMatchObject({
      type: "integer",
      exclusiveMinimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(parameters.properties?.positiveCount).not.toMatchObject({
      minimum: expect.any(Number),
    });
    expect(parameters.properties?.negativeRatio).toMatchObject({
      type: "number",
      minimum: Number.MIN_SAFE_INTEGER,
      exclusiveMaximum: 0,
    });
    expect(parameters.properties?.negativeRatio).not.toMatchObject({
      maximum: expect.any(Number),
    });
  });

  it("keeps literal discriminators as singleton enums for portable model-facing schemas", () => {
    const inputSchema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("process"), pid: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(),
      z.object({ kind: z.literal("http"), url: z.string().url() }).strict(),
    ]);

    const parameters = toToolDefinition(makeTool(inputSchema)).function.parameters as {
      anyOf?: Array<{ properties?: Record<string, unknown> }>;
      oneOf?: unknown;
      allOf?: unknown;
      additionalProperties?: unknown;
      properties?: Record<string, unknown>;
    };

    expect(parameters.anyOf).toBeUndefined();
    expect(parameters.oneOf).toBeUndefined();
    expect(parameters.allOf).toBeUndefined();
    expect(parameters.additionalProperties).toBe(false);
    expect(Object.keys(parameters.properties ?? {}).sort()).toEqual(["kind", "pid", "url"]);
    expect(parameters.properties?.kind).toEqual({ type: "string", enum: ["process", "http"] });
  });

  it("preserves user input fields named like schema metadata", () => {
    const inputSchema = z.object({
      "$schema": z.string().min(1),
      kind: z.literal("metadata_probe"),
    }).strict();

    const parameters = toToolDefinition(makeTool(inputSchema)).function.parameters as {
      $schema?: unknown;
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(parameters.$schema).toBeUndefined();
    expect(parameters.required).toContain("$schema");
    expect(parameters.properties?.["$schema"]).toMatchObject({
      type: "string",
      minLength: 1,
    });
    expect(parameters.properties?.kind).toEqual({
      type: "string",
      enum: ["metadata_probe"],
    });
  });
});
