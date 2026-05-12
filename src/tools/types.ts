import { z } from "zod";
import type { ExecutionPolicy, SubagentRole } from "../orchestrator/execution/agent-loop/execution-policy.js";
import type { PermissionGrantRecord } from "../runtime/store/permission-grant-store.js";
import type {
  PermissionWaitCanonicalPlan,
  PermissionWaitPlanStore,
} from "../runtime/store/permission-wait-plan-store.js";
import type {
  CapabilityAuditRecord,
  CapabilityOperationKind,
  CapabilityRiskClass,
  CapabilitySideEffectProfile,
  CapabilityVerificationRef,
} from "../runtime/store/capability-verification-schemas.js";

// --- Tool Result ---

const NonNegativeSafeIntegerSchema = z.number()
  .finite()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const ToolExecutionReasonSchema = z.enum([
  "approval_denied",
  "permission_denied",
  "policy_blocked",
  "dry_run",
  "tool_error",
  "timed_out",
  "interrupted",
  "sandbox_required",
  "escalation_required",
  "stale_state",
]);

export const ToolResultSchema = z.object({
  /** Whether the tool invocation succeeded */
  success: z.boolean(),
  /** The output data (type depends on tool) */
  data: z.unknown(),
  /** Human-readable summary of the result */
  summary: z.string(),
  /** Optional error message on failure */
  error: z.string().optional(),
  /**
   * Whether the tool implementation actually ran.
   * Approval-denied and policy-blocked calls are not executed side effects.
   */
  execution: z.object({
    status: z.enum(["executed", "not_executed"]),
    reason: ToolExecutionReasonSchema.optional(),
    message: z.string().optional(),
  }).optional(),
  /** Duration of the tool call in milliseconds */
  durationMs: NonNegativeSafeIntegerSchema,
  /** Optional context modifier: instructions to append to subsequent LLM context */
  contextModifier: z.string().optional(),
  /**
   * Optional output artifacts (file paths read, URLs fetched, etc.)
   * Used by verification to trace what the tool accessed.
   */
  artifacts: z.array(z.string()).optional(),
  /** Set when output was truncated; contains the original character count */
  truncated: z.object({ 
    originalChars: NonNegativeSafeIntegerSchema,
    overflowPath: z.string().optional()
  }).optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

export type HostToolExecutionDecisionStatus =
  | "allowed"
  | "denied"
  | "needs_permission"
  | "needs_sandbox"
  | "needs_escalation"
  | "fail_closed";

export interface HostToolExecutionDecision {
  status: HostToolExecutionDecisionStatus;
  reason: string;
  executionReason?: NonNullable<ToolResult["execution"]>["reason"];
  requiredSandboxMode?: "workspace_write" | "danger_full_access";
  requiredApprovalPolicy?: "on_request";
}

// --- Permission Level ---

export const ToolPermissionLevelSchema = z.enum([
  "read_only",      // No side effects: Glob, Grep, Read, HttpFetch(GET), JsonQuery
  "read_metrics",   // Reads with potential side effects (Shell for metrics: spawns processes)
  "write_local",    // Local filesystem writes (future: Write, Edit)
  "execute",        // Arbitrary execution (future: Shell with side effects)
  "write_remote",   // Remote side effects (future: HttpFetch POST/PUT/DELETE)
]);

export type ToolPermissionLevel = z.infer<typeof ToolPermissionLevelSchema>;

// --- Tool Activity Category ---

export const ToolActivityCategorySchema = z.enum([
  "search",
  "read",
  "planning",
  "command",
  "file_create",
  "file_modify",
  "test",
  "approval",
]);

export type ToolActivityCategory = z.infer<typeof ToolActivityCategorySchema>;

export const GatewayToolExposureSchema = z.enum([
  "default_safe",
  "approval_required",
  "runtime_control",
  "never",
]);

export type GatewayToolExposure = z.infer<typeof GatewayToolExposureSchema>;

// --- Tool Metadata ---

export const ToolMetadataSchema = z.object({
  /** Unique tool name (e.g., "glob", "shell") */
  name: z.string().min(1),
  /** Alternative names for discovery */
  aliases: z.array(z.string().min(1)).default([]),
  /** Permission level */
  permissionLevel: ToolPermissionLevelSchema,
  /** Whether this tool is read-only (no side effects) */
  isReadOnly: z.boolean(),
  /** Whether this tool can cause irreversible changes */
  isDestructive: z.boolean(),
  /**
   * Whether to defer loading this tool from the LLM context.
   * Deferred tools are hidden from the LLM tool list until explicitly
   * searched for via a ToolSearch mechanism. This saves context budget
   * for rarely-used tools.
   */
  shouldDefer: z.boolean().default(false),
  /** Whether this tool should always be loaded into context */
  alwaysLoad: z.boolean().default(false),
  /** Maximum concurrent invocations (0 = unlimited) */
  maxConcurrency: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  /** Maximum characters of tool output to pass to LLM (excess persisted to disk) */
  maxOutputChars: z.number().finite().int().positive().max(Number.MAX_SAFE_INTEGER).default(8000),
  /**
   * Tags for categorization and filtering.
   * Used by the context-filtered tier of the registry.
   */
  tags: z.array(z.string().min(1)).default([]),
  /** Whether this tool requires network access even if it is otherwise read-only. */
  requiresNetwork: z.boolean().optional(),
  /**
   * Channel-agnostic activity category used by shared agent timeline summaries.
   * Tools should declare this instead of requiring timeline consumers to infer
   * semantics from tool names.
   */
  activityCategory: ToolActivityCategorySchema.optional(),
  /**
   * Explicit gateway exposure policy. Read-only is necessary but not sufficient
   * for external chat surfaces; tools must opt into the gateway catalog.
   */
  gatewayExposure: GatewayToolExposureSchema.optional(),
});

export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;

// --- Tool Interface ---

/**
 * Core tool interface. Every tool (built-in or plugin-provided) implements this.
 *
 * Generic parameters:
 *   TInput  - Zod-validated input type
 *   TOutput - Structured output type (wrapped in ToolResult)
 */
export interface ITool<TInput = unknown, TOutput = unknown> {
  /** Tool metadata (name, permissions, etc.) */
  readonly metadata: ToolMetadata;

  /** Zod schema for input validation (gate 1 of the executor pipeline) */
  readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;

  /**
   * Dynamic description that may change per invocation context.
   * The LLM sees this description when deciding whether to use the tool.
   * Context parameters allow the description to adapt (e.g., showing
   * current working directory for file tools).
   */
  description(context?: ToolDescriptionContext): string;

  /**
   * Execute the tool. Input has already been validated by inputSchema.
   * Returns a ToolResult containing the output and metadata.
   */
  call(input: TInput, context: ToolCallContext): Promise<ToolResult>;

  /**
   * Check whether the tool can be invoked with the given input.
   * This is gate 2 of the executor pipeline (semantic validation).
   * Returns null if OK, or a rejection reason string.
   */
  checkPermissions(
    input: TInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult>;

  /**
   * Whether this tool can be safely invoked concurrently with the given input.
   * This is INPUT-DEPENDENT: e.g., two Read calls to different files = safe;
   * two Shell calls to the same cwd = unsafe (potential interference).
   */
  isConcurrencySafe(input: TInput): boolean;
}

// --- Supporting Types ---

export interface ToolDescriptionContext {
  /** Current working directory (for file-related tools) */
  cwd?: string;
  /** Goal context (so tools can tailor their description) */
  goalId?: string;
  /** Available data sources */
  dataSources?: string[];
}

export interface CapabilityExecutionContext {
  operationId?: string;
  providerRef?: string;
  assetRef?: string;
  capabilityId?: string;
  operationKind?: CapabilityOperationKind;
  toolName?: string;
  payloadClass?: string;
  riskClass?: CapabilityRiskClass;
  sideEffectProfile?: CapabilitySideEffectProfile;
  userDirected?: boolean;
  initiatedBy?: string;
  sourceSurface?: string;
  readinessSnapshotRefs?: string[];
  autonomyDecisionRef?: string;
  approvalRefs?: string[];
  executionRefs?: string[];
  userVisibleEffect?: string;
  sideEffectSummary?: string;
}

export interface CapabilityExecutionResolutionInput {
  toolName: string;
  toolMetadata: ToolMetadata;
  rawInput: unknown;
  operationKind: CapabilityOperationKind;
  payloadClass: string;
  riskClass: CapabilityRiskClass;
  sideEffectProfile: CapabilitySideEffectProfile;
}

export type CapabilityExecutionResolver = (
  input: CapabilityExecutionResolutionInput
) => CapabilityExecutionContext | null | Promise<CapabilityExecutionContext | null>;

export interface ToolCallContext {
  /** Current working directory */
  cwd: string;
  /** Goal ID for trust/permission lookups */
  goalId: string;
  /** Owning task ID when a tool runs inside a task-scoped agent loop. */
  taskId?: string;
  /** Trust balance for the current context */
  trustBalance: number;
  /** Whether the user has pre-approved certain operations */
  preApproved: boolean;
  /** Approval callback for interactive permission requests */
  approvalFn: (request: ApprovalRequest) => Promise<boolean>;
  /** Optional hook emitted before approvalFn is invoked */
  onApprovalRequested?: (request: ApprovalRequest & { callId?: string }) => Promise<void> | void;
  /** When true, bypass DENY_PATTERNS in ShellTool (internal use only) */
  trusted?: boolean;
  /** Shared execution policy for chat/agent-loop sessions. */
  executionPolicy?: ExecutionPolicy;
  /** Host-owned typed state used to fail closed when a request was based on stale runtime/session state. */
  hostToolState?: {
    currentEpoch: string;
    observedEpoch?: string;
  };
  /** Optional durable run identifier for scope-bound permission grants. */
  runId?: string;
  /** Optional turn identifier for scope-bound permission grants. */
  turnId?: string;
  /** Optional project identifier for scope-bound permission grants. */
  projectId?: string;
  /** Durable permission grants available to the host/tool permission path. */
  permissionGrantStore?: {
    list(): Promise<PermissionGrantRecord[]>;
    recordUse(grantId: string, input?: { used_at?: number; audit_ref?: string }): Promise<PermissionGrantRecord | null>;
  };
  /** Durable canonical plans for approval-gated tool calls. */
  permissionWaitPlanStore?: Pick<
    PermissionWaitPlanStore,
    "createWaiting" | "markApproved" | "markDenied" | "markExpired" | "resumeApproved"
  >;
  /** Durable operation evidence store for capability runtime production executions. */
  capabilityVerificationStore?: {
    saveVerification(record: CapabilityVerificationRef): Promise<CapabilityVerificationRef>;
    saveAudit(record: CapabilityAuditRecord): Promise<CapabilityAuditRecord>;
  };
  /** Typed capability operation context supplied by production caller paths. */
  capabilityExecution?: CapabilityExecutionContext;
  /** Optional resolver that binds production tool calls to current capability operation contracts. */
  capabilityExecutionResolver?: CapabilityExecutionResolver;
  /** Optional subagent role for delegated runs. */
  agentRole?: SubagentRole;
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
  /** Timeout in milliseconds (per-tool-call) */
  timeoutMs?: number;
  /** Session identifier for correlation in audit logs */
  sessionId?: string;
  /** Owning chat conversation session id when the tool runs inside chat. */
  conversationSessionId?: string;
  /** Chat-surface RunSpec confirmation state bridge for model-visible RunSpec tools. */
  runSpecConfirmation?: {
    get(): unknown | null | Promise<unknown | null>;
    set(value: unknown | null): void | Promise<void>;
    currentTurnStartedAt?: string;
  };
  /** Latest turn reply target when a chat/gateway surface exposes one to tools. */
  runtimeReplyTarget?: Record<string, unknown> | null;
  /** Latest turn runtime-control actor metadata when a chat/gateway surface exposes one to tools. */
  runtimeControlActor?: Record<string, unknown> | null;
  /** Whether the ingress surface is authorized for runtime-control lifecycle operations. */
  runtimeControlAllowed?: boolean;
  /** Runtime-control approval mode supplied by the ingress/gateway boundary. */
  runtimeControlApprovalMode?: "interactive" | "preapproved" | "disallowed";
  /** Setup secret intake from the current turn. Values are tool-private and must not be returned. */
  setupSecretIntake?: unknown | null;
  /** Chat-surface setup dialogue state bridge for setup tools. */
  setupDialogue?: {
    get(): unknown | null | Promise<unknown | null>;
    set(value: unknown | null): void | Promise<void>;
  };
  /** Base dir used for provider/gateway config lookups. */
  providerConfigBaseDir?: string;
  /** Unique call identifier for correlation in audit logs */
  callId?: string;
  /** Optional logger for audit-trail events */
  logger?: {
    debug: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** When true, gates pass but tool.call() is skipped (for testing pipelines) */
  dryRun?: boolean;
}

export interface ApprovalRequest {
  toolName: string;
  input: unknown;
  reason: string;
  permissionLevel: ToolPermissionLevel;
  isDestructive: boolean;
  reversibility: "reversible" | "irreversible" | "unknown";
  callId?: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
  approvalId?: string;
  permissionWaitPlanId?: string;
  canonicalPermissionPlan?: PermissionWaitCanonicalPlan;
  permissionGrantDecision?: unknown;
}

export const PermissionCheckResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("allowed"), permissionGrantDecision: z.unknown().optional() }),
  z.object({
    status: z.literal("denied"),
    reason: z.string(),
    executionReason: ToolExecutionReasonSchema.optional(),
    policyDecision: z.unknown().optional(),
    permissionGrantDecision: z.unknown().optional(),
  }),
  z.object({
    status: z.literal("needs_approval"),
    reason: z.string(),
    executionReason: ToolExecutionReasonSchema.optional(),
    policyDecision: z.unknown().optional(),
    permissionGrantDecision: z.unknown().optional(),
  }),
]);

export type PermissionCheckResult = z.infer<typeof PermissionCheckResultSchema> & {
  policyDecision?: HostToolExecutionDecision;
  permissionGrantDecision?: unknown;
};
