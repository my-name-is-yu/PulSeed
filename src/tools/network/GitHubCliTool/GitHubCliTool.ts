import { z } from "zod";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../types.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";

const MAX_OUTPUT_CHARS = 20_000;
const SAFE_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const GitHubReadInputSchema = z.object({
  action: z.enum([
    "repo_view",
    "pr_view",
    "pr_checks",
    "pr_diff",
    "pr_comments",
    "run_list",
    "run_view",
    "run_logs",
    "issue_view",
  ]),
  repo: z.string().regex(SAFE_REPO_RE, "repo must be owner/name").optional(),
  pr: z.number().int().positive().optional(),
  issue: z.number().int().positive().optional(),
  run_id: z.union([z.string().min(1), z.number().int().positive()]).optional(),
  limit: z.number().int().min(1).max(100).default(20),
  patch: z.boolean().default(true),
  maxChars: z.number().int().min(100).max(100_000).default(MAX_OUTPUT_CHARS),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});
export type GitHubReadInput = z.infer<typeof GitHubReadInputSchema>;

export const GitHubPrCreateInputSchema = z.object({
  repo: z.string().regex(SAFE_REPO_RE, "repo must be owner/name").optional(),
  title: z.string().min(1).max(300),
  body: z.string().max(20_000).default(""),
  base: z.string().min(1).max(200).optional(),
  head: z.string().min(1).max(200).optional(),
  draft: z.boolean().default(true),
  fill: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(30_000),
});
export type GitHubPrCreateInput = z.infer<typeof GitHubPrCreateInputSchema>;

export interface GitHubCliOutput {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export class GitHubReadTool implements ITool<GitHubReadInput, GitHubCliOutput> {
  readonly metadata: ToolMetadata = {
    name: "github_read",
    aliases: ["gh_read", "github_pr_read", "github_ci_read"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 3,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: ["github", "pr", "ci", "network", "agentloop"],
  };

  readonly inputSchema = GitHubReadInputSchema;

  description(): string {
    return "Read GitHub repository, PR, issue, and Actions status through the gh CLI. Requires gh to be installed and authenticated.";
  }

  async call(input: GitHubReadInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const validationError = validateGitHubReadInput(input);
    if (validationError) {
      return failure(validationError, startTime);
    }

    const args = buildGitHubReadArgs(input);
    const result = await execFileNoThrow("gh", args, { cwd: context.cwd, timeoutMs: input.timeoutMs });
    const stdout = truncate(result.stdout, input.maxChars);
    const stderr = truncate(result.stderr, input.maxChars);
    const data: GitHubCliOutput = {
      command: "gh",
      args,
      stdout,
      stderr,
      exitCode: result.exitCode,
    };
    const succeeded = result.exitCode === 0;

    return {
      success: succeeded,
      data,
      summary: succeeded
        ? `gh ${args.slice(0, 3).join(" ")} succeeded${stdout ? `: ${stdout.slice(0, 200)}` : ""}`
        : `gh ${args.slice(0, 3).join(" ")} failed: ${stderr.slice(0, 300)}`,
      error: succeeded ? undefined : stderr.slice(0, 500),
      durationMs: Date.now() - startTime,
      artifacts: input.repo ? [`github:${input.repo}`] : undefined,
    };
  }

  async checkPermissions(input: GitHubReadInput): Promise<PermissionCheckResult> {
    const validationError = validateGitHubReadInput(input);
    if (validationError) {
      return { status: "denied", reason: validationError };
    }
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: GitHubReadInput): boolean {
    return true;
  }
}

export class GitHubPrCreateTool implements ITool<GitHubPrCreateInput, GitHubCliOutput> {
  readonly metadata: ToolMetadata = {
    name: "github_pr_create",
    aliases: ["gh_pr_create", "create_github_pr"],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: ["github", "pr", "network", "agentloop"],
  };

  readonly inputSchema = GitHubPrCreateInputSchema;

  description(): string {
    return "Create a GitHub pull request through the gh CLI. Defaults to draft PRs.";
  }

  async call(input: GitHubPrCreateInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = buildGitHubPrCreateArgs(input);
    const result = await execFileNoThrow("gh", args, { cwd: context.cwd, timeoutMs: input.timeoutMs });
    const stdout = truncate(result.stdout, MAX_OUTPUT_CHARS);
    const stderr = truncate(result.stderr, MAX_OUTPUT_CHARS);
    const data: GitHubCliOutput = {
      command: "gh",
      args,
      stdout,
      stderr,
      exitCode: result.exitCode,
    };
    const succeeded = result.exitCode === 0;

    return {
      success: succeeded,
      data,
      summary: succeeded
        ? `GitHub PR created${stdout ? `: ${stdout.slice(0, 200)}` : ""}`
        : `GitHub PR creation failed: ${stderr.slice(0, 300)}`,
      error: succeeded ? undefined : stderr.slice(0, 500),
      durationMs: Date.now() - startTime,
      artifacts: input.repo ? [`github:${input.repo}`] : undefined,
    };
  }

  async checkPermissions(input: GitHubPrCreateInput): Promise<PermissionCheckResult> {
    if (input.fill && input.body.trim().length > 0) {
      return { status: "denied", reason: "Use either fill=true or an explicit body, not both." };
    }
    return { status: "needs_approval", reason: "Creating a GitHub pull request changes remote repository state." };
  }

  isConcurrencySafe(_input: GitHubPrCreateInput): boolean {
    return false;
  }
}

function validateGitHubReadInput(input: GitHubReadInput): string | null {
  if ((input.action === "run_view" || input.action === "run_logs") && input.run_id === undefined) {
    return `${input.action} requires run_id`;
  }
  if (input.action === "issue_view" && input.issue === undefined) {
    return "issue_view requires issue";
  }
  return null;
}

function buildGitHubReadArgs(input: GitHubReadInput): string[] {
  switch (input.action) {
    case "repo_view": {
      const args = ["repo", "view"];
      if (input.repo) args.push(input.repo);
      args.push("--json", "nameWithOwner,description,url,defaultBranchRef,isPrivate,viewerPermission");
      return args;
    }
    case "pr_view": {
      return withRepo([
        "pr", "view", ...optionalNumber(input.pr),
        "--json", "number,title,state,author,headRefName,baseRefName,url,isDraft,mergeStateStatus,reviewDecision,statusCheckRollup",
      ], input.repo);
    }
    case "pr_checks": {
      return withRepo(["pr", "checks", ...optionalNumber(input.pr)], input.repo);
    }
    case "pr_diff": {
      return withRepo(["pr", "diff", ...optionalNumber(input.pr), ...(input.patch ? ["--patch"] : [])], input.repo);
    }
    case "pr_comments": {
      return withRepo([
        "pr", "view", ...optionalNumber(input.pr),
        "--comments",
        "--json", "number,title,url,comments,reviews",
      ], input.repo);
    }
    case "run_list": {
      return withRepo([
        "run", "list",
        "--limit", String(input.limit),
        "--json", "databaseId,displayTitle,status,conclusion,workflowName,headBranch,event,createdAt,url",
      ], input.repo);
    }
    case "run_view": {
      return withRepo([
        "run", "view", String(input.run_id),
        "--json", "databaseId,displayTitle,status,conclusion,workflowName,headBranch,headSha,event,createdAt,updatedAt,url",
      ], input.repo);
    }
    case "run_logs": {
      return withRepo(["run", "view", String(input.run_id), "--log-failed"], input.repo);
    }
    case "issue_view": {
      return withRepo([
        "issue", "view", String(input.issue),
        "--comments",
        "--json", "number,title,state,author,body,comments,url",
      ], input.repo);
    }
  }
}

function buildGitHubPrCreateArgs(input: GitHubPrCreateInput): string[] {
  const args = ["pr", "create", "--title", input.title];
  if (input.fill) {
    args.push("--fill");
  } else {
    args.push("--body", input.body);
  }
  if (input.base) args.push("--base", input.base);
  if (input.head) args.push("--head", input.head);
  if (input.draft) args.push("--draft");
  return withRepo(args, input.repo);
}

function optionalNumber(value: number | undefined): string[] {
  return value === undefined ? [] : [String(value)];
}

function withRepo(args: string[], repo: string | undefined): string[] {
  if (!repo) return args;
  return [...args, "--repo", repo];
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function failure(message: string, startTime: number): ToolResult {
  return {
    success: false,
    data: null,
    summary: message,
    error: message,
    durationMs: Date.now() - startTime,
  };
}
