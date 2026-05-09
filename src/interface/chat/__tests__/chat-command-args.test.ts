import { describe, expect, it } from "vitest";
import { defaultExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";
import {
  COMMAND_HELP,
  parseCleanupArgs,
  parseDetailOnlyArgs,
  parseModelArgs,
  parsePermissionArgs,
  parseStatusArgs,
} from "../chat-command-args.js";

describe("chat command argument parsers", () => {
  it("keeps command help as the canonical slash-command surface", () => {
    expect(COMMAND_HELP).toContain("/permissions [args]");
    expect(COMMAND_HELP).toContain("/model <model> [effort]");
    expect(COMMAND_HELP).toContain("/retry is intentionally not supported yet.");
  });

  it("parses cleanup dry-run arguments", () => {
    expect(parseCleanupArgs("")).toEqual({ success: true, dryRun: false });
    expect(parseCleanupArgs("  --dry-run ")).toEqual({ success: true, dryRun: true });
    expect(parseCleanupArgs("--force")).toEqual({
      success: false,
      output: "Usage: /cleanup [--dry-run]",
    });
  });

  it("parses detail-only command flags", () => {
    expect(parseDetailOnlyArgs("--details", "/goals")).toEqual({ success: true, diagnostic: true });
    expect(parseDetailOnlyArgs("--diagnostic", "/sessions")).toEqual({ success: true, diagnostic: true });
    expect(parseDetailOnlyArgs("extra", "/goals")).toEqual({
      success: false,
      output: "Usage: /goals [--details]",
    });
  });

  it("parses status selectors and rejects ambiguous extras", () => {
    expect(parseStatusArgs("--details")).toEqual({ success: true, diagnostic: true });
    expect(parseStatusArgs("goal-1 --diagnostic")).toEqual({
      success: true,
      goalId: "goal-1",
      diagnostic: true,
    });
    expect(parseStatusArgs("goal-1 goal-2")).toEqual({
      success: false,
      output: "Usage: /status [goal-id] [--details]",
    });
  });

  it("parses model and reasoning arguments", () => {
    expect(parseModelArgs("high")).toEqual({ reasoning: "high" });
    expect(parseModelArgs("gpt-5.5 low")).toEqual({ model: "gpt-5.5", reasoning: "low" });
    expect(parseModelArgs("gpt-5.5 turbo")).toEqual({
      error: "Invalid reasoning effort \"turbo\". Valid: none, minimal, low, medium, high, xhigh",
    });
    expect(parseModelArgs("gpt-5.5 low extra")).toEqual({
      error: "Usage: /model <model> [none|minimal|low|medium|high|xhigh]",
    });
  });

  it("applies permission policy arguments without command side effects", () => {
    const policy = defaultExecutionPolicy("/repo");
    const parsed = parsePermissionArgs(policy, "read-only network on approval never");

    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error(parsed.output);
    expect(parsed.policy.sandboxMode).toBe("read_only");
    expect(parsed.policy.networkAccess).toBe(true);
    expect(parsed.policy.approvalPolicy).toBe("never");
  });

  it("rejects malformed permission arguments with the command usage", () => {
    const policy = defaultExecutionPolicy("/repo");
    expect(parsePermissionArgs(policy, "approval sometimes")).toEqual({
      success: false,
      output: "Usage: /permissions [read-only|workspace-write|full-access] [network on|off] [approval on_request|never|untrusted]",
    });
  });
});
