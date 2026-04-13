import { describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ApplyPatchTool } from "../ApplyPatchTool.js";
import type { ToolCallContext } from "../../../types.js";

function makeContext(cwd: string): ToolCallContext {
  return {
    cwd,
    goalId: "goal-1",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => false,
  };
}

describe("ApplyPatchTool", () => {
  it("applies Codex add-file patches", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "apply-patch-add-"));
    const tool = new ApplyPatchTool();

    const result = await tool.call({
      patch: [
        "*** Begin Patch",
        "*** Add File: result.txt",
        "+real-dogfood-ok",
        "*** End Patch",
        "",
      ].join("\n"),
      checkOnly: false,
    }, makeContext(cwd));

    expect(result.success).toBe(true);
    expect(await fsp.readFile(path.join(cwd, "result.txt"), "utf-8")).toBe("real-dogfood-ok\n");
    await fsp.rm(cwd, { recursive: true, force: true });
  });

  it("applies Codex update-file patches", async () => {
    const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), "apply-patch-update-"));
    await fsp.writeFile(path.join(cwd, "settings.txt"), "mode=dogfood\nenabled=false\n", "utf-8");
    const tool = new ApplyPatchTool();

    const result = await tool.call({
      patch: [
        "*** Begin Patch",
        "*** Update File: settings.txt",
        "@@",
        "-enabled=false",
        "+enabled=true",
        "*** End Patch",
        "",
      ].join("\n"),
      checkOnly: false,
    }, makeContext(cwd));

    expect(result.success).toBe(true);
    expect(await fsp.readFile(path.join(cwd, "settings.txt"), "utf-8")).toBe("mode=dogfood\nenabled=true\n");
    await fsp.rm(cwd, { recursive: true, force: true });
  });
});
