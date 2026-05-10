import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { SoilDoctorInputSchema, SoilDoctorTool } from "../SoilDoctorTool/SoilDoctorTool.js";
import { SoilImportInputSchema, SoilImportTool } from "../SoilImportTool/SoilImportTool.js";
import { SoilOpenInputSchema, SoilOpenTool } from "../SoilOpenTool/SoilOpenTool.js";
import { SoilPublishInputSchema, SoilPublishTool } from "../SoilPublishTool/SoilPublishTool.js";
import { SoilRebuildInputSchema, SoilRebuildTool } from "../SoilRebuildTool/SoilRebuildTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface SoilMaintenanceToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const SOIL_MAINTENANCE_TOOL_SCHEMA_CASES: SoilMaintenanceToolSchemaCase[] = [
  {
    name: "soil-doctor",
    schema: SoilDoctorInputSchema,
    validInput: { rootDir: "/tmp/soil" },
    tool: new SoilDoctorTool(),
  },
  {
    name: "soil-import",
    schema: SoilImportInputSchema,
    validInput: { action: "approve", overlayId: "overlay-1", rootDir: "/tmp/soil" },
    tool: new SoilImportTool(),
  },
  {
    name: "soil-open",
    schema: SoilOpenInputSchema,
    validInput: { rootDir: "/tmp/soil", viewer: "default", target: "root" },
    tool: new SoilOpenTool(),
  },
  {
    name: "soil-publish",
    schema: SoilPublishInputSchema,
    validInput: { provider: "all", dryRun: true, rootDir: "/tmp/soil" },
    tool: new SoilPublishTool(),
  },
  {
    name: "soil-rebuild",
    schema: SoilRebuildInputSchema,
    validInput: { baseDir: "/tmp/pulseed", rootDir: "/tmp/soil" },
    tool: new SoilRebuildTool(),
  },
];

describe("Soil maintenance tool input schema contracts", () => {
  it.each(SOIL_MAINTENANCE_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(SOIL_MAINTENANCE_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
