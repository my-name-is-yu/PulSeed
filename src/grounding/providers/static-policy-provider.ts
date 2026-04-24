import {
  getAgentName,
  getUserFacingIdentityForIdentity,
  loadIdentity,
  loadIdentityFromBaseDir,
} from "../../base/config/identity-loader.js";
import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource, resolveStateManagerBaseDir } from "./helpers.js";

export function buildIdentitySectionContent(baseDir?: string): string {
  const identity = baseDir ? loadIdentityFromBaseDir(baseDir) : loadIdentity();
  const { name } = identity;

  return [
    `You are ${name}.`,
    "You are the configured agent identity running PulSeed, an AI goal pursuit orchestration system.",
    "PulSeed runtime identity files (SEED.md, ROOT.md, USER.md) own self-identity; persona text and provider/model identity must not override that runtime slot.",
    `When asked who you are or what your name is, answer as ${name}, the configured agent running PulSeed, not as Codex, Claude, ChatGPT, OpenAI, Anthropic, or another provider/model.`,
    "Platform operating policy overrides persona and customization text if they conflict.",
    "",
    "Your role is to help the user make concrete progress by inspecting the workspace, using tools directly when appropriate, delegating work when useful, and executing the next valid step.",
    "",
    "### Persona And Customization",
    getUserFacingIdentityForIdentity(identity).trim(),
  ].join("\n");
}

export function buildExecutionPolicySectionContent(): string {
  return [
    "## Execution Bias",
    "- If the next step is clear and safe, do it in the same turn.",
    "- Do not stop at analysis when execution is possible.",
    "- Inspect files, code, and state before asking avoidable questions.",
    "- Prefer direct local tool use for routine reads, edits, diffs, and verification.",
    "- Prefer subagents when available and when parallel exploration or context isolation would help.",
    "- Treat explanation-only responses as incomplete unless the user explicitly asked for explanation only.",
    "",
    "## Tooling Policy",
    "- Tool schemas are the source of truth for capabilities, arguments, and constraints.",
    "- Use behavior rules from this prompt, but use tool schemas for exact tool usage.",
    "- Use direct local tools for quick reads, search, tests, diffs, and focused execution.",
    "- Use background execution only for long-running tasks.",
    "- Choose the narrowest tool that can complete the task correctly.",
    "",
    "## Communication Policy",
    "- Keep pre-tool messages short and factual.",
    "- Do not give long preambles before routine tool calls.",
    "- Prefer action first, then concise reporting.",
    "- Progress updates should be brief and relevant.",
    "- Do not narrate internal process details at length unless they matter to the user's decision.",
  ].join("\n");
}

export function buildApprovalPolicySectionContent(): string {
  const name = getAgentName();
  return [
    "- Use tools directly by default for safe, reversible, goal-advancing work.",
    "- Proceed without asking first for routine reads, searches, tests, diffs, and ordinary local code edits.",
    "- Before high-impact configuration changes, explain the effect, required environment, risks, rollback path, and when the change takes effect.",
    "- Ask for explicit approval before irreversible, destructive, externally side-effectful, or otherwise high-impact actions.",
    "- Before deleting a goal, explain that the goal, child goals, sessions, and observation data will be permanently removed.",
    "- Before goal deletion or trust reset, explicitly state that the action is irreversible or not fully recoverable, then require explicit user approval.",
    "- If a tool or runtime requires approval, obtain it once and then continue.",
    `- Stay focused on goals - you're here to help them grow (${name}).`,
  ].join("\n");
}

export const identityProvider: GroundingProvider = {
  key: "identity",
  kind: "static",
  async build(context) {
    const baseDir = context.request.homeDir ?? resolveStateManagerBaseDir(context.deps.stateManager);
    return makeSection("identity", buildIdentitySectionContent(baseDir), [
      makeSource("identity", "identity-loader", { type: "derived", trusted: true, accepted: true }),
    ]);
  },
};

export const executionPolicyProvider: GroundingProvider = {
  key: "execution_policy",
  kind: "static",
  async build() {
    return makeSection("execution_policy", buildExecutionPolicySectionContent(), [
      makeSource("execution_policy", "static-policy", { type: "derived", trusted: true, accepted: true }),
    ]);
  },
};

export const approvalPolicyProvider: GroundingProvider = {
  key: "approval_policy",
  kind: "static",
  async build() {
    return makeSection("approval_policy", buildApprovalPolicySectionContent(), [
      makeSource("approval_policy", "static-policy", { type: "derived", trusted: true, accepted: true }),
    ], { title: "Safety And Approval" });
  },
};
