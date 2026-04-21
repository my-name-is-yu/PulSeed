import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type { AgentLoopResolvedProfile } from "./agent-loop-default-profile.js";
import {
  formatAgentLoopResolvedProfileSummary,
  summarizeAgentLoopResolvedProfile,
} from "./agent-loop-default-profile.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
  AgentLoopReasoningEffort,
} from "./agent-loop-model.js";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { withDefaultBudget } from "./agent-loop-turn-context.js";
import type { BoundedAgentLoopRunner } from "./bounded-agent-loop-runner.js";
import { buildAgentLoopBaseInstructions } from "./agent-loop-prompts.js";
import { summarizeExecutionPolicy, type ExecutionPolicy } from "./execution-policy.js";
import type { ToolCallContext } from "../../../tools/types.js";

export const ReviewAgentLoopOutputSchema = z.object({
  status: z.enum(["clean", "needs_attention", "blocked"]).default("clean"),
  summary: z.string(),
  findings: z.array(z.string()).default([]),
  suggestedChecks: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
});

export type ReviewAgentLoopOutput = z.infer<typeof ReviewAgentLoopOutputSchema>;

export interface ReviewAgentLoopRunnerDeps {
  boundedRunner: BoundedAgentLoopRunner;
  modelClient: AgentLoopModelClient;
  modelRegistry: AgentLoopModelRegistry;
  defaultModel?: AgentLoopModelRef;
  cwd?: string;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultToolPolicy?: AgentLoopToolPolicy;
  defaultToolCallContext?: Partial<ToolCallContext>;
  defaultReasoningEffort?: AgentLoopReasoningEffort;
  defaultExecutionPolicy?: ExecutionPolicy;
  profile?: AgentLoopResolvedProfile;
  createSession?: () => AgentLoopSession;
}

export interface ReviewAgentLoopInput {
  cwd?: string;
  diffStat?: string | null;
  executionPolicy: ExecutionPolicy;
  model?: AgentLoopModelRef;
}

export interface ReviewAgentLoopResult {
  success: boolean;
  output: string;
  review: ReviewAgentLoopOutput | null;
}

export class ReviewAgentLoopRunner {
  constructor(private readonly deps: ReviewAgentLoopRunnerDeps) {}

  async execute(input: ReviewAgentLoopInput): Promise<ReviewAgentLoopResult> {
    const cwd = input.cwd ?? this.deps.cwd ?? process.cwd();
    const model = input.model ?? this.deps.defaultModel ?? await this.deps.modelRegistry.defaultModel();
    const modelInfo = await this.deps.modelClient.getModelInfo(model);
    const session = this.deps.createSession?.() ?? createAgentLoopSession();
    const result = await this.deps.boundedRunner.run({
      session,
      turnId: randomUUID(),
      goalId: "review",
      profileName: this.deps.profile?.name ?? "review",
      cwd,
      model,
      modelInfo,
      reasoningEffort: this.deps.defaultReasoningEffort ?? this.deps.profile?.reasoningEffort,
      messages: [
        {
          role: "system",
          content: buildAgentLoopBaseInstructions({
            mode: "review",
            role: "reviewer",
            extraRules: [
              "Review the current workspace diff and supporting evidence without making edits.",
              "Report only material defects, regressions, or missing verification.",
              "If the diff is clean, say so directly.",
            ],
          }),
        },
        {
          role: "user",
          content: [
            "Review the current workspace state.",
            input.diffStat?.trim()
              ? `Git diff stat:\n${input.diffStat.trim()}`
              : "Git diff stat:\nNo uncommitted changes detected.",
            "Resolved runtime posture:",
            summarizeExecutionPolicy(input.executionPolicy),
            "Return schema-valid review findings only.",
          ].join("\n\n"),
        },
      ],
      outputSchema: ReviewAgentLoopOutputSchema,
      budget: withDefaultBudget(this.deps.defaultBudget),
      toolPolicy: { ...this.deps.defaultToolPolicy },
      executionPolicy: this.deps.defaultExecutionPolicy ?? input.executionPolicy,
      toolCallContext: {
        cwd,
        goalId: "review",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
        ...this.deps.defaultToolCallContext,
      },
    });

    const review = result.output;
    const finalReview = review ?? {
      status: "blocked" as const,
      summary: result.finalText || result.stopReason,
      findings: [],
      suggestedChecks: [],
      evidence: [],
    };

    return {
      success: result.success && review !== null,
      output: formatReviewOutput(finalReview, this.deps.profile, input.executionPolicy),
      review,
    };
  }
}

function formatReviewOutput(
  review: ReviewAgentLoopOutput,
  profile: AgentLoopResolvedProfile | undefined,
  executionPolicy: ExecutionPolicy,
): string {
  const lines = [
    "Review summary",
    review.summary,
    "",
    "Execution policy",
    summarizeExecutionPolicy(executionPolicy),
    "",
    "Review profile",
    formatAgentLoopResolvedProfileSummary(
      summarizeAgentLoopResolvedProfile(profile ?? { name: "review", executionPolicy }, executionPolicy),
    ),
    "",
    `status: ${review.status}`,
  ];

  if (review.findings.length > 0) {
    lines.push("", "findings:");
    for (const finding of review.findings) {
      lines.push(`- ${finding}`);
    }
  }

  if (review.suggestedChecks.length > 0) {
    lines.push("", "suggested checks:");
    for (const check of review.suggestedChecks) {
      lines.push(`- ${check}`);
    }
  }

  if (review.evidence.length > 0) {
    lines.push("", "evidence:");
    for (const item of review.evidence) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join("\n");
}
