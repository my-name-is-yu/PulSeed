import { z } from "zod/v3";
import type { StateManager } from "../../base/state/state-manager.js";
import {
  createRuntimeDreamSidecarReview,
  RuntimeDreamSidecarReviewError,
} from "../../runtime/dream-sidecar-review.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";

export const RuntimeDreamReviewInputSchema = z.object({
  run_id: z.string().min(1, "run_id is required"),
  request_guidance_injection: z.boolean().default(false),
}).strict();
export type RuntimeDreamReviewInput = z.infer<typeof RuntimeDreamReviewInputSchema>;

export class RuntimeDreamReviewTool implements ITool<RuntimeDreamReviewInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "runtime_dream_review",
    aliases: ["dream_review_run", "runtime_sidecar_dream_review"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 16000,
    tags: ["session", "runtime", "dream", "self-grounding"],
  };
  readonly inputSchema = RuntimeDreamReviewInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return "Attach a read-only Dream sidecar review to an active runtime/background run by id.";
  }

  async call(input: RuntimeDreamReviewInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const review = await createRuntimeDreamSidecarReview({
        stateManager: this.stateManager,
        runId: input.run_id,
        requestGuidanceInjection: input.request_guidance_injection,
      });
      return {
        success: true,
        data: review,
        summary: `Read-only Dream review attached to ${review.run.id}: ${review.trend_state.state}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const code = error instanceof RuntimeDreamSidecarReviewError ? error.code : "unknown";
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        data: { code },
        summary: `runtime_dream_review failed: ${message}`,
        error: message,
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
