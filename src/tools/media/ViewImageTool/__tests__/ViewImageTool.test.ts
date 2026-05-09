import { describe, expect, it } from "vitest";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { ViewImageInputSchema, ViewImageTool } from "../ViewImageTool.js";

describe("ViewImageTool", () => {
  const tool = new ViewImageTool();

  it("rejects unknown fields and exports a closed model-facing schema", () => {
    expect(ViewImageInputSchema.safeParse({
      path: "/tmp/image.png",
      unexpected: true,
    }).success).toBe(false);

    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });

  it("preserves the detail default", () => {
    const parsed = ViewImageInputSchema.parse({ path: "/tmp/image.png" });
    expect(parsed.detail).toBe("auto");
  });
});
