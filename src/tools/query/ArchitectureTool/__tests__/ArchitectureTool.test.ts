import { describe, expect, it } from "vitest";
import { ArchitectureTool } from "../ArchitectureTool.js";

describe("ArchitectureTool", () => {
  it("describes direct tool use without stale delegate-only wording", async () => {
    const tool = new ArchitectureTool();
    const result = await tool.call({}, {
      cwd: "/repo",
      goalId: "goal-1",
      trustBalance: 0,
      preApproved: false,
      approvalFn: async () => false,
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      core_concept: {
        execution_boundary: expect.stringContaining("uses available tools directly"),
      },
    });
    expect(JSON.stringify(result.data)).not.toContain("PulSeed always delegates");
    expect(JSON.stringify(result.data)).not.toContain("state read/write only");
  });
});
