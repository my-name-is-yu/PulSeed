import { randomUUID } from 'node:crypto';
import { z } from 'zod/v3';
import { StateManager } from '../../base/state/state-manager.js';
import {
  Checkpoint,
  CheckpointSchema,
  CheckpointIndex,
  CheckpointIndexSchema,
} from '../../base/types/checkpoint.js';
import type { IPromptGateway } from '../../prompt/gateway.js';

interface LLMClient {
  chat(messages: Array<{ role: string; content: string }>): Promise<{ content: string }>;
}

interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

const CheckpointAdaptResponseSchema = z.object({
  adapted_context: z.string(),
});

interface CheckpointManagerDeps {
  stateManager: StateManager;
  llmClient?: LLMClient;
  logger?: Logger;
  gateway?: IPromptGateway;
}

export class CheckpointManager {
  constructor(private readonly deps: CheckpointManagerDeps) {}

  private async readIndex(goalId: string): Promise<CheckpointIndex> {
    try {
      return CheckpointIndexSchema.parse({
        goal_id: goalId,
        checkpoints: await this.deps.stateManager.listCheckpointEntries(goalId),
      });
    } catch {
      this.deps.logger?.warn('checkpoint index parse failed, resetting', { goalId });
      return { goal_id: goalId, checkpoints: [] };
    }
  }

  async saveCheckpoint(params: {
    goalId: string;
    taskId: string;
    agentId: string;
    sessionContextSnapshot: string;
    intermediateResults?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<Checkpoint> {
    const checkpoint = CheckpointSchema.parse({
      checkpoint_id: randomUUID(),
      goal_id: params.goalId,
      task_id: params.taskId,
      agent_id: params.agentId,
      session_context_snapshot: params.sessionContextSnapshot,
      intermediate_results: params.intermediateResults ?? [],
      created_at: new Date().toISOString(),
      metadata: params.metadata ?? {},
    });

    await this.deps.stateManager.saveCheckpoint(checkpoint);

    this.deps.logger?.info('checkpoint saved', {
      checkpointId: checkpoint.checkpoint_id,
      goalId: params.goalId,
    });

    return checkpoint;
  }

  async loadCheckpoint(goalId: string, taskId?: string): Promise<Checkpoint | null> {
    try {
      return await this.deps.stateManager.loadLatestCheckpoint(goalId, taskId);
    } catch {
      this.deps.logger?.warn('checkpoint parse failed', {
        goalId,
        taskId,
      });
      return null;
    }
  }

  async loadAndAdaptCheckpoint(
    goalId: string,
    currentAgentId: string,
    taskId?: string,
  ): Promise<{ checkpoint: Checkpoint; adaptedContext: string; wasAdapted: boolean } | null> {
    const checkpoint = await this.loadCheckpoint(goalId, taskId);
    if (!checkpoint) return null;

    if (checkpoint.agent_id === currentAgentId) {
      return { checkpoint, adaptedContext: checkpoint.session_context_snapshot, wasAdapted: false };
    }

    if (!this.deps.llmClient && !this.deps.gateway) {
      return { checkpoint, adaptedContext: checkpoint.session_context_snapshot, wasAdapted: false };
    }

    const prompt =
      `You are helping transfer context from agent '${checkpoint.agent_id}' to agent '${currentAgentId}'. ` +
      `Summarize and adapt the following session context and intermediate results for the new agent to continue the work.\n\n` +
      `Context:\n${checkpoint.session_context_snapshot}\n\n` +
      `Intermediate Results:\n${checkpoint.intermediate_results.join('\n')}`;

    try {
      if (this.deps.gateway) {
        const result = await this.deps.gateway.execute({
          purpose: "checkpoint_adapt",
          goalId,
          additionalContext: { adapt_prompt: prompt },
          responseSchema: CheckpointAdaptResponseSchema,
        });
        return { checkpoint, adaptedContext: result.adapted_context, wasAdapted: true };
      } else {
        const response = await this.deps.llmClient!.chat([{ role: 'user', content: prompt }]);
        return { checkpoint, adaptedContext: response.content, wasAdapted: true };
      }
    } catch (err) {
      this.deps.logger?.error('context adaptation failed', { error: String(err) });
      return { checkpoint, adaptedContext: checkpoint.session_context_snapshot, wasAdapted: false };
    }
  }

  async listCheckpoints(goalId: string): Promise<CheckpointIndex['checkpoints']> {
    const index = await this.readIndex(goalId);
    return index.checkpoints;
  }

  async deleteCheckpoint(goalId: string, checkpointId: string): Promise<void> {
    await this.deps.stateManager.deleteCheckpoint(goalId, checkpointId);
    this.deps.logger?.info('checkpoint deleted', { checkpointId, goalId });
  }

  async garbageCollect(goalId: string, maxAgeDays = 7): Promise<number> {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const deleted = await this.deps.stateManager.garbageCollectCheckpoints(goalId, cutoff);
    this.deps.logger?.info('garbage collected checkpoints', { goalId, count: deleted });
    return deleted;
  }
}
