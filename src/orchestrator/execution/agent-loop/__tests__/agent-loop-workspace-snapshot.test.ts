import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  captureAgentLoopWorkspaceSnapshot,
  collectAgentLoopChangedFiles,
} from "../agent-loop-workspace-snapshot.js";

describe("agent loop workspace snapshot", () => {
  it("ignores Codex runtime state when detecting filesystem changes", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-agentloop-snapshot-"));
    try {
      fs.mkdirSync(path.join(workspace, ".codex"), { recursive: true });
      fs.writeFileSync(path.join(workspace, ".codex", "auth.json"), "before", "utf8");
      fs.writeFileSync(path.join(workspace, "result.txt"), "before", "utf8");

      const before = await captureAgentLoopWorkspaceSnapshot(workspace);

      fs.writeFileSync(path.join(workspace, ".codex", "auth.json"), "after", "utf8");
      fs.writeFileSync(path.join(workspace, "result.txt"), "after", "utf8");

      await expect(collectAgentLoopChangedFiles(workspace, before)).resolves.toEqual(["result.txt"]);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
