import { describe, it, expect, vi, afterEach } from "vitest";
import { GitHubPrCreateInputSchema, GitHubPrCreateTool, GitHubReadInputSchema, GitHubReadTool } from "../GitHubCliTool.js";
import type { ToolCallContext } from "../../../types.js";
import * as execMod from "../../../../base/utils/execFileNoThrow.js";

const makeContext = (cwd = "/tmp"): ToolCallContext => ({
  goalId: "goal-1",
  cwd,
  trustBalance: 0,
  preApproved: false,
  approvalFn: async () => false,
});

describe("GitHubReadTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds gh pr view args with repo and JSON fields", async () => {
    const tool = new GitHubReadTool();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
      stdout: "{\"number\":12}",
      stderr: "",
      exitCode: 0,
    });

    const input = GitHubReadInputSchema.parse({ action: "pr_view", pr: 12, repo: "owner/repo" });
    const result = await tool.call(input, makeContext("/repo"));

    expect(result.success).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      "gh",
      expect.arrayContaining(["pr", "view", "12", "--repo", "owner/repo"]),
      expect.objectContaining({ cwd: "/repo", timeoutMs: 30_000 }),
    );
  });

  it("denies run log reads without run_id", async () => {
    const tool = new GitHubReadTool();
    const input = GitHubReadInputSchema.parse({ action: "run_logs" });
    const permission = await tool.checkPermissions(input);
    expect(permission.status).toBe("denied");
  });
});

describe("GitHubPrCreateTool", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requires approval because it writes remote GitHub state", async () => {
    const tool = new GitHubPrCreateTool();
    const input = GitHubPrCreateInputSchema.parse({ title: "Add feature", body: "Body" });
    const permission = await tool.checkPermissions(input);
    expect(permission.status).toBe("needs_approval");
  });

  it("creates draft PRs by default through gh", async () => {
    const tool = new GitHubPrCreateTool();
    const execSpy = vi.spyOn(execMod, "execFileNoThrow").mockResolvedValueOnce({
      stdout: "https://github.com/owner/repo/pull/1",
      stderr: "",
      exitCode: 0,
    });

    const input = GitHubPrCreateInputSchema.parse({
      repo: "owner/repo",
      title: "Add feature",
      body: "Body",
      base: "main",
      head: "feature",
    });
    const result = await tool.call(input, makeContext("/repo"));

    expect(result.success).toBe(true);
    expect(execSpy).toHaveBeenCalledWith(
      "gh",
      [
        "pr", "create",
        "--title", "Add feature",
        "--body", "Body",
        "--base", "main",
        "--head", "feature",
        "--draft",
        "--repo", "owner/repo",
      ],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("denies fill=true with explicit body", async () => {
    const tool = new GitHubPrCreateTool();
    const input = GitHubPrCreateInputSchema.parse({ title: "Add feature", body: "Body", fill: true });
    const permission = await tool.checkPermissions(input);
    expect(permission.status).toBe("denied");
  });
});
