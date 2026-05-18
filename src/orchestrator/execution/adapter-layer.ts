// ─── AdapterLayer ───
//
// Defines the IAdapter interface, AgentTask/AgentResult types, and
// AdapterRegistry for managing multiple adapter implementations.
// This is the abstraction layer that isolates TaskLifecycle from
// concrete agent implementations (Claude Code CLI, Claude API, etc.).

import { AdapterError } from "../../base/utils/errors.js";
import type { VerificationFileDiff } from "../../base/types/task.js";
import type { AgentLoopReasoningEffort } from "./agent-loop/agent-loop-model.js";
import type { AgentLoopFailureReason, AgentLoopWorkspaceDisposition } from "./agent-loop/agent-loop-result.js";

// ─── Types ───

export interface AgentTask {
  /** Session context + task instructions to pass to the agent */
  prompt: string;
  /** Timeout in milliseconds */
  timeout_ms: number;
  /** Which adapter to use for this task */
  adapter_type: string;
  /** Tool/capability allowlist — locked at task creation, immutable during execution */
  allowed_tools?: readonly string[];
  /** Working directory override for the agent process (e.g., target workspace path) */
  cwd?: string;
  /** System prompt to inject identity/context (used by chat grounding) */
  system_prompt?: string;
  /** Capability Plane admission proving this adapter execution is not a direct production bypass. */
  capability_plane_admission?: AdapterCapabilityPlaneAdmission;
}

export interface AdapterCapabilityPlaneAdmission {
  schema_version: "adapter-capability-plane-admission/v1";
  boundary: "run_adapter_tool" | "provider_adapter" | "descriptor_internal" | "test";
  descriptor_id: string;
  admission_id: string;
}

const ADAPTER_CAPABILITY_PLANE_ADMISSION_BOUNDARIES = new Set<AdapterCapabilityPlaneAdmission["boundary"]>([
  "run_adapter_tool",
  "provider_adapter",
  "descriptor_internal",
  "test",
]);

export interface AgentLoopExecutionInfo {
  traceId: string;
  sessionId: string;
  turnId: string;
  stopReason: string;
  failureReason?: AgentLoopFailureReason;
  failureDetail?: string;
  modelTurns: number;
  toolCalls: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  compactions: number;
  completionEvidence?: string[];
  verificationHints?: string[];
  completionArtifacts?: AgentCompletionArtifact[];
  filesChangedPaths?: string[];
  requestedCwd?: string;
  executionCwd?: string;
  isolatedWorkspace?: boolean;
  workspaceCleanupStatus?: "not_requested" | "cleaned_up" | "kept";
  workspaceCleanupReason?: string;
  workspaceDirty?: boolean;
  workspaceDisposition?: AgentLoopWorkspaceDisposition;
  profileName?: string;
  reasoningEffort?: AgentLoopReasoningEffort;
  sandboxMode?: string;
  approvalPolicy?: string;
  networkAccess?: boolean;
  activeBudgetMs?: number;
  generatedEstimateMs?: number;
  requiresPostVerificationBeforeSuccessLedger?: boolean;
}

export interface AgentCompletionArtifact {
  path: string;
  sourceTool?: string;
  kind?: string;
}

export interface AgentResult {
  /** Whether the task completed without error or timeout */
  success: boolean;
  /** stdout from CLI / LLM response text */
  output: string;
  /** Parsed machine-readable result, when a caller explicitly requested structured output. */
  structuredOutput?: unknown;
  /** stderr / error message, null on success */
  error: string | null;
  /** Process exit code for CLI adapters; null for API adapters */
  exit_code: number | null;
  /** Wall-clock time from execute() call to resolution, in milliseconds */
  elapsed_ms: number;
  /** How execution ended */
  stopped_reason: "completed" | "timeout" | "error" | "cancelled" | "blocked" | "policy_blocked";
  /**
   * Whether the adapter actually modified any files, as detected by git diff --stat.
   * undefined = check was not performed (e.g., not a git repo, or adapter skipped).
   * true = files were changed; false = adapter reported success but no files changed.
   */
  filesChanged?: boolean;
  /** Relative file paths changed during execution, when available. */
  filesChangedPaths?: string[];
  /** Unified diffs captured immediately after execution, when available. */
  fileDiffs?: VerificationFileDiff[];
  /** Source used to determine changed paths and diffs. */
  diffEvidenceSource?: "git" | "filesystem_artifact" | "unavailable";
  /** Durable artifacts produced by tools that can mechanically prove task completion. */
  completionArtifacts?: AgentCompletionArtifact[];
  /** Execution was interrupted by daemon shutdown and should be recovered, not verified as a terminal task result. */
  interruptedByDaemonShutdown?: boolean;
  /** Native agentloop execution metadata when the task ran through the in-process loop. */
  agentLoop?: AgentLoopExecutionInfo;
}

// ─── Interface ───

export interface IAdapter {
  execute(task: AgentTask): Promise<AgentResult>;
  readonly adapterType: string;
  readonly capabilities?: readonly string[];
  readonly capabilityPlaneBoundary?: AdapterCapabilityPlaneAdmission["boundary"];
  /** Optional: return titles of existing tasks for dedup context injection into prompts. */
  listExistingTasks?(): Promise<string[]>;
  /** Optional: adapter-specific duplicate detection. Returns true if a duplicate exists. Fail-open: return false on error. */
  checkDuplicate?(task: AgentTask): Promise<boolean>;
  /**
   * Optional: format a prompt string from a task and optional workspace context.
   * When implemented, task-executor uses this instead of the default prompt builder.
   * Receives the raw Task (not AgentTask) so the adapter can access work_description etc.
   */
  formatPrompt?(task: import("../../base/types/task.js").Task, workspaceContext?: string): string;
}

export function adapterExecutionHasCapabilityPlaneAdmission(task: AgentTask, adapter: IAdapter): boolean {
  const admission = task.capability_plane_admission;
  if (!isAdapterCapabilityPlaneAdmission(admission)) return false;
  if (adapter.capabilityPlaneBoundary === undefined) return false;
  return admission.boundary === adapter.capabilityPlaneBoundary;
}

export function isAdapterCapabilityPlaneAdmission(
  admission: AgentTask["capability_plane_admission"]
): admission is AdapterCapabilityPlaneAdmission {
  return admission?.schema_version === "adapter-capability-plane-admission/v1"
    && ADAPTER_CAPABILITY_PLANE_ADMISSION_BOUNDARIES.has(admission.boundary)
    && typeof admission.descriptor_id === "string"
    && admission.descriptor_id.trim().length > 0
    && typeof admission.admission_id === "string"
    && admission.admission_id.trim().length > 0;
}

export function blockedDirectAdapterExecutionResult(adapterType: string): AgentResult {
  return {
    success: false,
    output: `Adapter ${adapterType} was blocked: direct adapter.execute() production bypass is disabled. Use the run-adapter ToolExecutor path or an explicit Capability Plane boundary.`,
    error: "adapter_direct_execution_blocked",
    exit_code: null,
    elapsed_ms: 0,
    stopped_reason: "policy_blocked",
  };
}

// ─── Circuit Breaker ───

type CircuitState = "closed" | "open" | "half_open";

interface CircuitBreaker {
  state: CircuitState;
  failure_count: number;
  last_failure_at: number; // Date.now()
  cooldown_ms: number;
}

const FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60_000;

// ─── AdapterRegistry ───

/**
 * Registry that maps adapter type strings to IAdapter instances.
 * Tracks per-adapter circuit breaker state for fault tolerance.
 */
export class AdapterRegistry {
  private readonly adapters: Map<string, IAdapter> = new Map();
  private readonly circuitBreakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Register an adapter. Overwrites any previously registered adapter
   * for the same adapterType.
   */
  register(adapter: IAdapter): void {
    this.adapters.set(adapter.adapterType, adapter);
  }

  /**
   * Retrieve an adapter by type string.
   * Throws if no adapter is registered for that type.
   */
  getAdapter(type: string): IAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) {
      throw new AdapterError(
        `AdapterRegistry: no adapter registered for type "${type}". ` +
          `Available types: [${this.listAdapters().join(", ")}]`
      );
    }
    return adapter;
  }

  /**
   * Returns a sorted list of all registered adapter type strings.
   */
  listAdapters(): string[] {
    return Array.from(this.adapters.keys()).sort();
  }

  /**
   * Returns capabilities for all registered adapters.
   * For adapters without capabilities defined, returns ["general_purpose"] as default.
   */
  getAdapterCapabilities(): Array<{ adapterType: string; capabilities: string[] }> {
    return Array.from(this.adapters.entries()).map(([type, adapter]) => ({
      adapterType: type,
      capabilities: adapter.capabilities ? Array.from(adapter.capabilities) : ["general_purpose"],
    }));
  }

  // ─── Circuit Breaker Methods ───

  private getCircuitBreaker(adapterName: string): CircuitBreaker {
    if (!this.circuitBreakers.has(adapterName)) {
      this.circuitBreakers.set(adapterName, {
        state: "closed",
        failure_count: 0,
        last_failure_at: 0,
        cooldown_ms: DEFAULT_COOLDOWN_MS,
      });
    }
    return this.circuitBreakers.get(adapterName)!;
  }

  /** Reset failure count and set circuit to closed after a successful execution. */
  recordSuccess(adapterName: string): void {
    const cb = this.getCircuitBreaker(adapterName);
    cb.state = "closed";
    cb.failure_count = 0;
  }

  /** Increment failure count; open the circuit when threshold is reached. */
  recordFailure(adapterName: string): void {
    const cb = this.getCircuitBreaker(adapterName);
    cb.failure_count += 1;
    cb.last_failure_at = Date.now();
    if (cb.failure_count >= FAILURE_THRESHOLD) {
      cb.state = "open";
    }
  }

  /**
   * Returns false if the circuit is open and cooldown has not elapsed.
   * If cooldown has passed, transitions to half_open and returns true (probe attempt).
   */
  isAvailable(adapterName: string): boolean {
    const cb = this.getCircuitBreaker(adapterName);
    if (cb.state !== "open") {
      return true;
    }
    const elapsed = Date.now() - cb.last_failure_at;
    if (elapsed >= cb.cooldown_ms) {
      cb.state = "half_open";
      return true;
    }
    return false;
  }

  /** Returns the current circuit state for inspection/testing. */
  getCircuitState(adapterName: string): CircuitState {
    return this.getCircuitBreaker(adapterName).state;
  }

  // ─── Capability Matching ───

  /**
   * Finds the first registered adapter whose capabilities include ALL required strings.
   * Excludes the named adapter and any adapter whose circuit is open.
   * Returns the adapter name, or null if no match found.
   */
  selectByCapability(required: string[], excludeAdapter?: string): string | null {
    for (const [name, adapter] of this.adapters) {
      if (excludeAdapter !== undefined && name === excludeAdapter) {
        continue;
      }
      if (!this.isAvailable(name)) {
        continue;
      }
      const caps = adapter.capabilities ? Array.from(adapter.capabilities) : ["general_purpose"];
      const hasAll = required.every((r) => caps.includes(r));
      if (hasAll) {
        return name;
      }
    }
    return null;
  }
}
