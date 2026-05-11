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
  const unionObjectBranches = collectUnionObjectBranches(parameters);
  if (unionObjectBranches !== null) {
    parameters.properties = collectObjectBranchProperties(unionObjectBranches);
    parameters.required = collectCommonRequiredProperties(unionObjectBranches);
    parameters.additionalProperties = unionObjectBranches.every((branch) => branch.additionalProperties === false)
      ? false
      : parameters.additionalProperties ?? false;
    delete parameters.anyOf;
    delete parameters.oneOf;
    delete parameters.allOf;
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

function collectUnionObjectBranches(schema: JsonObject): JsonObject[] | null {
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : Array.isArray(schema.allOf)
        ? schema.allOf
        : null;
  if (!branches || branches.length === 0) return null;

  const objectBranches: JsonObject[] = [];
  for (const branch of branches) {
    if (!isJsonObject(branch)) return null;
    if (branch.type === "object" && isJsonObject(branch.properties)) {
      objectBranches.push(branch);
      continue;
    }
    const nested = collectUnionObjectBranches(branch);
    if (!nested) return null;
    objectBranches.push(...nested);
  }

  return objectBranches.length > 0 ? objectBranches : null;
}

function collectObjectBranchProperties(branches: JsonObject[]): JsonObject {
  const merged: JsonObject = {};
  for (const branch of branches) {
    if (!isJsonObject(branch.properties)) continue;
    for (const [key, value] of Object.entries(branch.properties)) {
      const existing = merged[key];
      merged[key] = existing === undefined ? value : mergePropertySchema(existing, value);
    }
  }
  return merged;
}

function collectCommonRequiredProperties(branches: JsonObject[]): string[] {
  const requiredSets = branches.map((branch) => (
    Array.isArray(branch.required)
      ? new Set(branch.required.filter((item): item is string => typeof item === "string"))
      : new Set<string>()
  ));
  if (requiredSets.length === 0) return [];
  const [first, ...rest] = requiredSets;
  return [...first].filter((item) => rest.every((set) => set.has(item)));
}

function mergePropertySchema(left: unknown, right: unknown): unknown {
  if (JSON.stringify(left) === JSON.stringify(right)) return left;
  if (!isJsonObject(left) || !isJsonObject(right)) return {};
  if (isRefOnlySchema(left)) return right;
  if (isRefOnlySchema(right)) return left;

  const leftEnum = enumValues(left);
  const rightEnum = enumValues(right);
  if (left.type === right.type && leftEnum && rightEnum) {
    return {
      type: left.type,
      enum: [...new Set([...leftEnum, ...rightEnum])],
    };
  }

  return {};
}

function isRefOnlySchema(value: JsonObject): boolean {
  return typeof value.$ref === "string" && Object.keys(value).length === 1;
}

function enumValues(value: JsonObject): string[] | null {
  if (!Array.isArray(value.enum)) return null;
  const values = value.enum.filter((item): item is string => typeof item === "string");
  return values.length === value.enum.length ? values : null;
}

/**
 * Convert a single ITool instance to a ToolDefinition (JSON schema format)
 * that the LLM client understands for function calling.
 */
export function toToolDefinition(tool: ITool): ToolDefinition {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, { target: "jsonSchema7", $refStrategy: "none" });
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
