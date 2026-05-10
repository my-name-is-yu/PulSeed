import { randomUUID } from "node:crypto";
import type { StateManager } from "../../base/state/state-manager.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import { EthicsLogStore, type EthicsLogStorePort } from "../../runtime/store/ethics-log-store.js";
import {
  EthicsVerdictSchema,
  EthicsLogSchema,
} from "../../base/types/ethics.js";
import type {
  EthicsVerdict,
  EthicsLog,
  EthicsSubjectType,
  CustomConstraintsConfig,
} from "../../base/types/ethics.js";
import { classifyExplicitEthicsMarker, ETHICS_SYSTEM_PROMPT } from "./ethics-rules.js";

// ─── Constants ───

const CONFIDENCE_FLAG_THRESHOLD = 0.6;

export function requiresManualEthicsReview(verdict: EthicsVerdict): boolean {
  return verdict.verdict === "flag" && (
    verdict.category === "classifier_unavailable" ||
    verdict.category === "parse_error" ||
    verdict.confidence < CONFIDENCE_FLAG_THRESHOLD
  );
}

// ─── EthicsGate ───

/**
 * EthicsGate performs LLM-based ethical evaluation of goals, subgoals, and tasks.
 * All verdicts (pass, flag, reject) are persisted to an ethics log.
 *
 * Persistence: typed ethics log runtime state store.
 *
 * Deterministic pre-check: exact protocol policy markers only.
 * Structured classifier: schema-constrained evaluation for freeform input.
 * Custom constraints: Injected into the Layer 2 LLM prompt as additional context.
 */
export class EthicsGate {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly customConstraints?: CustomConstraintsConfig;
  private readonly gateway?: IPromptGateway;
  private ethicsLogStore: EthicsLogStorePort | null;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    customConstraints?: CustomConstraintsConfig,
    gateway?: IPromptGateway,
    ethicsLogStore?: EthicsLogStorePort,
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.customConstraints = customConstraints;
    this.gateway = gateway;
    this.ethicsLogStore = ethicsLogStore ?? null;
  }

  // ─── Private: Log I/O ───

  private async loadLogs(): Promise<EthicsLog[]> {
    return this.getEthicsLogStore().loadLogs();
  }

  private async appendLog(entry: EthicsLog): Promise<void> {
    await this.getEthicsLogStore().appendLog(EthicsLogSchema.parse(entry));
  }

  private getEthicsLogStore(): EthicsLogStorePort {
    this.ethicsLogStore ??= new EthicsLogStore(this.stateManager.getBaseDir());
    return this.ethicsLogStore;
  }

  // ─── Private: Deterministic policy-marker evaluation ───

  /**
   * Checks exact protocol markers only.
   * Freeform descriptions are always sent to the structured classifier.
   */
  private checkDeterministicMarker(description: string): EthicsVerdict | null {
    return classifyExplicitEthicsMarker(description);
  }

  // ─── Private: LLM evaluation ───

  private buildUserMessage(
    subjectType: EthicsSubjectType,
    description: string,
    context?: string,
    applyConstraints?: boolean
  ): string {
    const lines: string[] = [
      `Subject type: ${subjectType}`,
      `Description: ${description}`,
    ];
    if (context) {
      lines.push(`Additional context: ${context}`);
    }
    if (applyConstraints && this.customConstraints && this.customConstraints.constraints.length > 0) {
      const goalConstraints = this.customConstraints.constraints.filter(
        (c) => c.applies_to === "goal"
      );
      if (goalConstraints.length > 0) {
        lines.push("");
        lines.push("Additional organizational constraints:");
        for (const constraint of goalConstraints) {
          lines.push(`- ${constraint.description}`);
        }
        lines.push("You MUST flag or reject any subject that violates these constraints.");
      }
    }
    return lines.join("\n");
  }

  private buildMeansUserMessage(
    taskDescription: string,
    means: string,
    applyConstraints?: boolean
  ): string {
    const lines = [
      `Subject type: task (means evaluation)`,
      `Task description: ${taskDescription}`,
      `Proposed means / execution method: ${means}`,
    ];
    if (applyConstraints && this.customConstraints && this.customConstraints.constraints.length > 0) {
      const meansConstraints = this.customConstraints.constraints.filter(
        (c) => c.applies_to === "task_means"
      );
      if (meansConstraints.length > 0) {
        lines.push("");
        lines.push("Additional organizational constraints:");
        for (const constraint of meansConstraints) {
          lines.push(`- ${constraint.description}`);
        }
        lines.push("You MUST flag or reject any subject that violates these constraints.");
      }
    }
    return lines.join("\n");
  }

  private parseVerdictSafe(content: string): EthicsVerdict {
    try {
      return this.llmClient.parseJSON(content, EthicsVerdictSchema);
    } catch {
      return {
        verdict: "flag",
        category: "parse_error",
        reasoning: `Failed to parse LLM response as valid EthicsVerdict. Raw content: ${content.slice(0, 200)}`,
        risks: [],
        confidence: 0,
      };
    }
  }

  private classifierUnavailableVerdict(error: unknown): EthicsVerdict {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: "flag",
      category: "classifier_unavailable",
      reasoning: `Ethics classifier unavailable; manual review required. ${message.slice(0, 160)}`,
      risks: ["classifier unavailable", "manual review required"],
      confidence: 0,
    };
  }

  private applyConfidenceOverride(verdict: EthicsVerdict): EthicsVerdict {
    if (verdict.confidence < CONFIDENCE_FLAG_THRESHOLD) {
      return {
        ...verdict,
        verdict: "flag",
        risks: verdict.risks.includes("manual review required")
          ? verdict.risks
          : [...verdict.risks, "manual review required"],
      };
    }
    return verdict;
  }

  /**
   * Runs the structured classifier, logs the result, and returns the verdict.
   * Called by both check() and checkMeans() after deterministic markers pass.
   */
  private async runLayer2(
    userMessage: string,
    subjectType: EthicsSubjectType,
    subjectId: string,
    subjectDescription: string
  ): Promise<EthicsVerdict> {
    let rawVerdict: EthicsVerdict;
    if (this.gateway) {
      rawVerdict = await this.gateway.execute({
        purpose: "ethics_evaluate",
        additionalContext: { ethics_prompt: userMessage },
        responseSchema: EthicsVerdictSchema,
        temperature: 0,
      });
    } else {
      const response = await this.llmClient.sendMessage(
        [{ role: "user", content: userMessage }],
        { system: ETHICS_SYSTEM_PROMPT, temperature: 0 }
      );
      rawVerdict = this.parseVerdictSafe(response.content);
    }
    const verdict = this.applyConfidenceOverride(rawVerdict);

    const logEntry: EthicsLog = EthicsLogSchema.parse({
      log_id: randomUUID(),
      timestamp: new Date().toISOString(),
      subject_type: subjectType,
      subject_id: subjectId,
      subject_description: subjectDescription,
      verdict,
      layer1_triggered: false,
    });
    await this.appendLog(logEntry);

    return verdict;
  }

  // ─── Public API ───

  /**
   * Evaluate a goal, subgoal, or task for ethical concerns.
   *
   * Steps:
   * 1. Run deterministic exact-marker pre-check.
   * 2. Build LLM prompt, injecting custom constraints for "goal" applies_to.
   * 3. Send ethics judgment prompt to the structured classifier.
   * 4. Parse response with EthicsVerdictSchema
   * 5. If confidence < CONFIDENCE_FLAG_THRESHOLD, auto-override verdict to "flag"
   * 6. Create EthicsLog entry, persist
   * 7. Return verdict
   *
   * On classifier failure: returns a conservative flag verdict.
   * On JSON parse failure: returns conservative fallback with verdict "flag".
   */
  async check(
    subjectType: EthicsSubjectType,
    subjectId: string,
    description: string,
    context?: string
  ): Promise<EthicsVerdict> {
    const markerResult = this.checkDeterministicMarker(description);
    if (markerResult !== null) {
      const logEntry: EthicsLog = EthicsLogSchema.parse({
        log_id: randomUUID(),
        timestamp: new Date().toISOString(),
        subject_type: subjectType,
        subject_id: subjectId,
        subject_description: description,
        verdict: markerResult,
        layer1_triggered: true,
      });
      await this.appendLog(logEntry);
      return markerResult;
    }

    const userMessage = this.buildUserMessage(subjectType, description, context, true);
    try {
      return await this.runLayer2(userMessage, subjectType, subjectId, description);
    } catch (error) {
      const verdict = this.classifierUnavailableVerdict(error);
      const logEntry: EthicsLog = EthicsLogSchema.parse({
        log_id: randomUUID(),
        timestamp: new Date().toISOString(),
        subject_type: subjectType,
        subject_id: subjectId,
        subject_description: description,
        verdict,
        layer1_triggered: false,
      });
      await this.appendLog(logEntry);
      return verdict;
    }
  }

  /**
   * Evaluate the execution means of a task for ethical concerns.
   * Used by TaskLifecycle to screen proposed execution methods before execution.
   *
   * Steps:
   * 1. Run deterministic exact-marker pre-check on combined taskDescription + means.
   * 2. Build LLM prompt, injecting custom constraints for "task_means" applies_to.
   * 3. Structured classifier evaluation.
   * 4. Log and return
   */
  async checkMeans(
    taskId: string,
    taskDescription: string,
    means: string
  ): Promise<EthicsVerdict> {
    const subjectDescription = `${taskDescription} | means: ${means}`;

    const markerResult =
      this.checkDeterministicMarker(taskDescription) ??
      this.checkDeterministicMarker(means);
    if (markerResult !== null) {
      const logEntry: EthicsLog = EthicsLogSchema.parse({
        log_id: randomUUID(),
        timestamp: new Date().toISOString(),
        subject_type: "task",
        subject_id: taskId,
        subject_description: subjectDescription,
        verdict: markerResult,
        layer1_triggered: true,
      });
      await this.appendLog(logEntry);
      return markerResult;
    }

    const userMessage = this.buildMeansUserMessage(taskDescription, means, true);
    try {
      return await this.runLayer2(userMessage, "task", taskId, subjectDescription);
    } catch (error) {
      const verdict = this.classifierUnavailableVerdict(error);
      const logEntry: EthicsLog = EthicsLogSchema.parse({
        log_id: randomUUID(),
        timestamp: new Date().toISOString(),
        subject_type: "task",
        subject_id: taskId,
        subject_description: subjectDescription,
        verdict,
        layer1_triggered: false,
      });
      await this.appendLog(logEntry);
      return verdict;
    }
  }

  /**
   * Retrieve all persisted ethics logs, with optional filtering.
   */
  async getLogs(filter?: {
    subjectId?: string;
    verdict?: "reject" | "flag" | "pass";
  }): Promise<EthicsLog[]> {
    let logs = await this.loadLogs();

    if (filter?.subjectId !== undefined) {
      const targetId = filter.subjectId;
      logs = logs.filter((log) => log.subject_id === targetId);
    }

    if (filter?.verdict !== undefined) {
      const targetVerdict = filter.verdict;
      logs = logs.filter((log) => log.verdict.verdict === targetVerdict);
    }

    return logs;
  }
}
