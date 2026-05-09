import { zodToJsonSchema } from "zod-to-json-schema";
import type { ITool } from "./types.js";
import type { ToolDefinition } from "../base/llm/llm-client.js";

function toolParametersFromSchema(jsonSchema: unknown): Record<string, unknown> {
  if (typeof jsonSchema !== "object" || jsonSchema === null || Array.isArray(jsonSchema)) {
    return {
      type: "object",
      properties: {},
      required: [],
    };
  }

  const { $schema: _schema, ...parameters } = jsonSchema as Record<string, unknown>;
  parameters.type = parameters.type ?? "object";

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

/**
 * Convert a single ITool instance to a ToolDefinition (JSON schema format)
 * that the LLM client understands for function calling.
 */
export function toToolDefinition(tool: ITool): ToolDefinition {
  const jsonSchema = zodToJsonSchema(tool.inputSchema, { target: "openApi3" });
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
