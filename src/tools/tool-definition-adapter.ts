import { zodToJsonSchema } from "zod-to-json-schema";
import type { ITool } from "./types.js";
import type { ToolDefinition } from "../base/llm/llm-client.js";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeSchemaNode);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$schema") continue;
    if (isSchemaNameMapKey(key) && isJsonObject(child)) {
      normalized[key] = normalizeSchemaNameMap(child);
      continue;
    }
    normalized[key] = normalizeSchemaNode(child);
  }

  removeWeakerInclusiveBoundary(normalized, "minimum", "exclusiveMinimum", (inclusive, exclusive) => inclusive <= exclusive);
  removeWeakerInclusiveBoundary(normalized, "maximum", "exclusiveMaximum", (inclusive, exclusive) => inclusive >= exclusive);
  normalizeConstLiteral(normalized);

  return normalized;
}

function isSchemaNameMapKey(key: string): boolean {
  return key === "properties" || key === "patternProperties" || key === "$defs" || key === "definitions";
}

function normalizeSchemaNameMap(value: JsonObject): JsonObject {
  const normalized: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    normalized[key] = normalizeSchemaNode(child);
  }
  return normalized;
}

function normalizeConstLiteral(schema: JsonObject): void {
  if (!Object.hasOwn(schema, "const") || schema.enum !== undefined) return;

  schema.enum = [schema.const];
  delete schema.const;
}

function removeWeakerInclusiveBoundary(
  schema: JsonObject,
  inclusiveKey: "minimum" | "maximum",
  exclusiveKey: "exclusiveMinimum" | "exclusiveMaximum",
  isWeakerOrEqual: (inclusive: number, exclusive: number) => boolean
): void {
  const inclusive = schema[inclusiveKey];
  const exclusive = schema[exclusiveKey];
  if (
    typeof inclusive === "number" &&
    Number.isFinite(inclusive) &&
    typeof exclusive === "number" &&
    Number.isFinite(exclusive) &&
    isWeakerOrEqual(inclusive, exclusive)
  ) {
    delete schema[inclusiveKey];
  }
}

function toolParametersFromSchema(jsonSchema: unknown): Record<string, unknown> {
  const normalizedSchema = normalizeSchemaNode(jsonSchema);

  if (!isJsonObject(normalizedSchema)) {
    return {
      type: "object",
      properties: {},
      required: [],
    };
  }

  const parameters = { ...normalizedSchema };
  parameters.type = parameters.type ?? "object";
  const unionObjectProperties = collectUnionObjectProperties(parameters);
  if (parameters.properties === undefined && unionObjectProperties !== null) {
    parameters.properties = unionObjectProperties;
    parameters.additionalProperties = parameters.additionalProperties ?? false;
  }

  if (
    parameters.properties === undefined &&
    parameters.anyOf === undefined &&
    parameters.oneOf === undefined &&
    parameters.allOf === undefined
  ) {
    parameters.properties = {};
    parameters.required = [];
  }

  return parameters;
}

function collectUnionObjectProperties(schema: JsonObject): JsonObject | null {
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null;
  if (!branches || branches.length === 0) return null;

  const merged: JsonObject = {};
  for (const branch of branches) {
    if (!isJsonObject(branch) || branch.type !== "object" || !isJsonObject(branch.properties)) {
      return null;
    }

    for (const [key, value] of Object.entries(branch.properties)) {
      const existing = merged[key];
      if (existing === undefined || JSON.stringify(existing) === JSON.stringify(value)) {
        merged[key] = value;
      } else {
        merged[key] = {};
      }
    }
  }

  return merged;
}

/**
 * Convert a single ITool instance to a ToolDefinition (JSON schema format)
 * that the LLM client understands for function calling.
 */
export function toToolDefinition(tool: ITool): ToolDefinition {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, { target: "jsonSchema7" });
  const parameters = toolParametersFromSchema(jsonSchema);

  return {
    type: "function",
    function: {
      name: tool.metadata.name,
      description: tool.description(),
      parameters,
    },
  };
}

/**
 * Convert an array of ITool instances to ToolDefinition array.
 */
export function toToolDefinitions(tools: ITool[]): ToolDefinition[] {
  return tools.map(toToolDefinition);
}

/**
 * Convert an array of ITool instances to ToolDefinition array,
 * optionally excluding tools that are deferred (shouldDefer=true)
 * unless they are marked alwaysLoad=true or are explicitly activated.
 */
export function toToolDefinitionsFiltered(
  tools: ITool[],
  options?: { activatedTools?: Set<string> }
): ToolDefinition[] {
  const activated = options?.activatedTools ?? new Set<string>();
  const filtered = tools.filter(
    (t) => !t.metadata.shouldDefer || t.metadata.alwaysLoad || activated.has(t.metadata.name)
  );
  return filtered.map(toToolDefinition);
}
