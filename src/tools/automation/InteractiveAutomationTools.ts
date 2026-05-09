import { z } from "zod";
import type { InteractiveAutomationCapability, InteractiveAutomationProviderFamily, InteractiveAutomationRegistry } from "../../runtime/interactive-automation/index.js";
import {
  BrowserSessionResolver,
  type BrowserSessionStore,
  type RuntimeAuthHandoffStore,
  type BrowserSessionScope,
} from "../../runtime/interactive-automation/index.js";
import type {
  BackpressureController,
  CircuitBreakerController,
} from "../../runtime/guardrails/index.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolDescriptionContext, ToolMetadata, ToolResult } from "../types.js";

const TAGS = ["automation", "interactive"];
const MAX_OUTPUT_CHARS = 12_000;
const DEFAULT_DENIED_APPS = ["Password Manager", "Banking", "System Settings"];
const MAX_DESKTOP_CLICK_COUNT = 10;

function desktopCoordinateSchema() {
  return z.number()
    .finite()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER);
}

const DesktopClickCountSchema = z.number()
  .finite()
  .int()
  .min(1)
  .max(MAX_DESKTOP_CLICK_COUNT)
  .default(1);

export interface InteractiveAutomationToolPolicy {
  requireApproval: "always" | "write" | "destructive";
  allowedApps?: readonly string[];
  deniedApps?: readonly string[];
}

export const DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY: InteractiveAutomationToolPolicy = {
  requireApproval: "always",
  deniedApps: DEFAULT_DENIED_APPS,
};

const ProviderInputSchema = z.object({
  providerId: z.string().optional(),
}).strict();

export const DesktopListAppsInputSchema = ProviderInputSchema;
export type DesktopListAppsInput = z.infer<typeof DesktopListAppsInputSchema>;

export const DesktopGetAppStateInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
});
export type DesktopGetAppStateInput = z.infer<typeof DesktopGetAppStateInputSchema>;

export const DesktopClickInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
  elementId: z.string().optional(),
  x: desktopCoordinateSchema().optional(),
  y: desktopCoordinateSchema().optional(),
  button: z.enum(["left", "right", "middle"]).default("left"),
  clickCount: DesktopClickCountSchema,
});
export type DesktopClickInput = z.infer<typeof DesktopClickInputSchema>;

export const DesktopTypeTextInputSchema = ProviderInputSchema.extend({
  app: z.string().min(1),
  text: z.string(),
});
export type DesktopTypeTextInput = z.infer<typeof DesktopTypeTextInputSchema>;

export const ResearchWebInputSchema = ProviderInputSchema.extend({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(20).optional(),
  domains: z.array(z.string().min(1)).optional(),
});
export type ResearchWebInput = z.infer<typeof ResearchWebInputSchema>;

export const ResearchAnswerInputSchema = ProviderInputSchema.extend({
  question: z.string().min(1),
  model: z.string().optional(),
});
export type ResearchAnswerInput = z.infer<typeof ResearchAnswerInputSchema>;

export const BrowserRunWorkflowInputSchema = ProviderInputSchema.extend({
  task: z.string().min(1),
  startUrl: z.string().url().optional(),
  sessionId: z.string().optional(),
  serviceKey: z.string().optional(),
});
export type BrowserRunWorkflowInput = z.infer<typeof BrowserRunWorkflowInputSchema>;

export const BrowserGetStateInputSchema = ProviderInputSchema.extend({
  sessionId: z.string().optional(),
  serviceKey: z.string().optional(),
  startUrl: z.string().url().optional(),
});
export type BrowserGetStateInput = z.infer<typeof BrowserGetStateInputSchema>;

export interface BrowserWorkflowRuntimeDeps {
  browserSessionStore?: BrowserSessionStore;
  authHandoffStore?: RuntimeAuthHandoffStore;
  circuitBreaker?: CircuitBreakerController;
  backpressure?: BackpressureController;
}

abstract class AutomationTool<TInput> implements ITool<TInput> {
  abstract readonly metadata: ToolMetadata;
  abstract readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, any>;

  constructor(
    protected readonly registry: InteractiveAutomationRegistry,
    protected readonly policy: InteractiveAutomationToolPolicy = DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY,
  ) {}

  abstract description(context?: ToolDescriptionContext): string;
  abstract call(input: TInput, context: ToolCallContext): Promise<ToolResult>;
  abstract checkPermissions(input: TInput, context: ToolCallContext): Promise<PermissionCheckResult>;
  abstract isConcurrencySafe(input: TInput): boolean;

  protected resolveProvider(input: { providerId?: string }, family: InteractiveAutomationProviderFamily, capability: InteractiveAutomationCapability) {
    return this.registry.resolve({
      providerId: input.providerId,
      family,
      capability,
    });
  }

  protected fail(summary: string, startTime: number): ToolResult {
    return {
      success: false,
      data: null,
      summary,
      error: summary,
      durationMs: Date.now() - startTime,
    };
  }

  protected success(data: unknown, summary: string, startTime: number): ToolResult {
    return {
      success: true,
      data,
      summary,
      durationMs: Date.now() - startTime,
    };
  }

  protected async availableOrFail(provider: { id: string; isAvailable: () => Promise<{ available: boolean; reason?: string }> } | undefined, startTime: number): Promise<ToolResult | null> {
    if (!provider) {
      return this.fail("No matching interactive automation provider is registered", startTime);
    }
    const availability = await provider.isAvailable();
    if (!availability.available) {
      return this.fail(`${provider.id} is unavailable: ${availability.reason ?? "unknown reason"}`, startTime);
    }
    return null;
  }

  protected checkDesktopMutationPolicy(app: string, action: string): PermissionCheckResult {
    const appName = app.trim();
    const allowedApps = this.policy.allowedApps ?? [];
    if (allowedApps.length > 0 && !matchesAnyApp(appName, allowedApps)) {
      return {
        status: "denied",
        reason: `${action} is not allowed for ${appName}; it is not in the interactive automation allowed_apps list`,
      };
    }

    if (matchesAnyApp(appName, this.policy.deniedApps ?? DEFAULT_DENIED_APPS)) {
      return {
        status: "denied",
        reason: `${action} is denied for protected app ${appName}`,
      };
    }

    if (this.policy.requireApproval === "always" || this.policy.requireApproval === "write") {
      return { status: "needs_approval", reason: `${action} in ${appName} requires approval` };
    }

    return { status: "allowed" };
  }
}

function matchesAnyApp(app: string, patterns: readonly string[]): boolean {
  const normalized = app.toLowerCase();
  return patterns.some((pattern) => {
    const candidate = pattern.trim().toLowerCase();
    return candidate.length > 0 && normalized.includes(candidate);
  });
}

export class DesktopListAppsTool extends AutomationTool<DesktopListAppsInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_list_apps",
    aliases: ["list_desktop_apps"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopListAppsInputSchema;

  description(): string {
    return "List desktop applications visible to the configured interactive automation provider.";
  }

  async call(input: DesktopListAppsInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_state");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.listApps) return this.fail(`${provider?.id ?? "provider"} does not support listing apps`, startTime);
    const apps = await provider.listApps();
    return this.success({ providerId: provider.id, apps }, `Found ${apps.length} desktop app(s) via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: DesktopListAppsInput): boolean {
    return true;
  }
}

export class DesktopGetAppStateTool extends AutomationTool<DesktopGetAppStateInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_get_app_state",
    aliases: ["get_desktop_app_state"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopGetAppStateInputSchema;

  description(): string {
    return "Inspect the current state of a desktop application through an automation provider.";
  }

  async call(input: DesktopGetAppStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_state");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.getAppState) return this.fail(`${provider?.id ?? "provider"} does not support app state`, startTime);
    const state = await provider.getAppState({ app: input.app });
    return this.success({ providerId: provider.id, state }, `Read state for ${input.app} via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: DesktopGetAppStateInput): boolean {
    return true;
  }
}

export class DesktopClickTool extends AutomationTool<DesktopClickInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_click",
    aliases: ["click_desktop"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopClickInputSchema;

  description(): string {
    return "Click a desktop coordinate or accessibility element through an automation provider.";
  }

  async call(input: DesktopClickInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_input");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.click) return this.fail(`${provider?.id ?? "provider"} does not support clicks`, startTime);
    const result = await provider.click({
      app: input.app,
      elementId: input.elementId,
      x: input.x,
      y: input.y,
      button: input.button,
      clickCount: input.clickCount,
    });
    return result.success
      ? this.success({ providerId: provider.id, result }, `Clicked ${input.app} via ${provider.id}`, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(input: DesktopClickInput): Promise<PermissionCheckResult> {
    return this.checkDesktopMutationPolicy(input.app, "Desktop click");
  }

  isConcurrencySafe(_input: DesktopClickInput): boolean {
    return false;
  }
}

export class DesktopTypeTextTool extends AutomationTool<DesktopTypeTextInput> {
  readonly metadata: ToolMetadata = {
    name: "desktop_type_text",
    aliases: ["type_desktop_text"],
    permissionLevel: "execute",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "desktop"],
  };
  readonly inputSchema = DesktopTypeTextInputSchema;

  description(): string {
    return "Type text into a desktop application through an automation provider.";
  }

  async call(input: DesktopTypeTextInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "desktop", "desktop_input");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.typeText) return this.fail(`${provider?.id ?? "provider"} does not support text input`, startTime);
    const result = await provider.typeText({ app: input.app, text: input.text });
    return result.success
      ? this.success({ providerId: provider.id, result }, `Typed ${input.text.length} character(s) into ${input.app} via ${provider.id}`, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(input: DesktopTypeTextInput): Promise<PermissionCheckResult> {
    const policyResult = this.checkDesktopMutationPolicy(input.app, `Typing ${input.text.length} character(s)`);
    if (policyResult.status === "needs_approval") {
      return {
        status: "needs_approval",
        reason: `Typing ${input.text.length} character(s) into ${input.app} requires approval`,
      };
    }
    return policyResult;
  }

  isConcurrencySafe(_input: DesktopTypeTextInput): boolean {
    return false;
  }
}

export class ResearchWebTool extends AutomationTool<ResearchWebInput> {
  readonly metadata: ToolMetadata = {
    name: "research_web",
    aliases: ["web_research"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "research"],
  };
  readonly inputSchema = ResearchWebInputSchema;

  description(): string {
    return "Run web research through the configured research automation provider.";
  }

  async call(input: ResearchWebInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "research", "web_research");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.researchWeb) return this.fail(`${provider?.id ?? "provider"} does not support web research`, startTime);
    const result = await provider.researchWeb({
      query: input.query,
      maxResults: input.maxResults,
      domains: input.domains,
    });
    return this.success({ providerId: provider.id, ...result }, `Found ${result.results.length} research result(s) via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ResearchWebInput): boolean {
    return true;
  }
}

export class ResearchAnswerWithSourcesTool extends AutomationTool<ResearchAnswerInput> {
  readonly metadata: ToolMetadata = {
    name: "research_answer_with_sources",
    aliases: ["answer_with_sources"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "research"],
  };
  readonly inputSchema = ResearchAnswerInputSchema;

  description(): string {
    return "Answer a research question with citations through the configured research provider.";
  }

  async call(input: ResearchAnswerInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "research", "web_research");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.answerWithSources) return this.fail(`${provider?.id ?? "provider"} does not support sourced answers`, startTime);
    const result = await provider.answerWithSources({ question: input.question, model: input.model });
    return this.success({ providerId: provider.id, ...result }, `Answered with ${result.citations.length} citation(s) via ${provider.id}`, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: ResearchAnswerInput): boolean {
    return true;
  }
}

export class BrowserRunWorkflowTool extends AutomationTool<BrowserRunWorkflowInput> {
  readonly metadata: ToolMetadata = {
    name: "browser_run_workflow",
    aliases: ["run_browser_workflow"],
    permissionLevel: "write_remote",
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "browser"],
  };
  readonly inputSchema = BrowserRunWorkflowInputSchema;

  constructor(
    registry: InteractiveAutomationRegistry,
    policy: InteractiveAutomationToolPolicy = DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY,
    private readonly runtimeDeps: BrowserWorkflowRuntimeDeps = {},
  ) {
    super(registry, policy);
  }

  description(): string {
    return "Ask the configured browser automation provider to run a browser workflow.";
  }

  async call(input: BrowserRunWorkflowInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "browser", "browser_control");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.runBrowserWorkflow) return this.fail(`${provider?.id ?? "provider"} does not support browser workflows`, startTime);
    const scope = buildBrowserScope(provider.id, input, _context);
    const sessionResolution = await new BrowserSessionResolver(this.runtimeDeps.browserSessionStore)
      .resolveForWorkflow({ scope, sessionId: input.sessionId });
    if (!sessionResolution.ok) {
      return {
        success: false,
        data: {
          providerId: provider.id,
          status: "browser_session_not_executed",
          code: sessionResolution.code,
          sessionId: sessionResolution.sessionId,
        },
        summary: sessionResolution.summary,
        error: sessionResolution.summary,
        durationMs: Date.now() - startTime,
      };
    }
    const resolvedSessionId = sessionResolution.sessionId;
    const breakerDecision = this.runtimeDeps.circuitBreaker
      ? await this.runtimeDeps.circuitBreaker.beforeRun(provider.id, scope.serviceKey)
      : { allowed: true as const };
    if (!breakerDecision.allowed) {
      return this.fail(`${provider.id} is paused by guardrail: ${breakerDecision.reason ?? "circuit breaker open"}`, startTime);
    }

    const runKey = `${provider.id}:${_context.callId ?? _context.sessionId ?? Date.now()}:${scope.serviceKey}`;
    const permit = this.runtimeDeps.backpressure
      ? await this.runtimeDeps.backpressure.acquire({
        providerId: provider.id,
        serviceKey: scope.serviceKey,
        runKey,
      })
      : { ok: true as const };
    if (!permit.ok) {
      return this.fail(`${provider.id} backpressure active: ${permit.reason}`, startTime);
    }

    try {
      const result = await provider.runBrowserWorkflow({
        task: input.task,
        startUrl: input.startUrl,
        sessionId: resolvedSessionId,
      });

      if (result.success) {
        if (this.runtimeDeps.browserSessionStore && result.sessionId) {
          await this.runtimeDeps.browserSessionStore.recordAuthenticated({
            sessionId: result.sessionId,
            providerId: provider.id,
            serviceKey: scope.serviceKey,
            workspace: scope.workspace,
            actorKey: scope.actorKey,
            metadata: input.startUrl ? { startUrl: input.startUrl } : undefined,
          });
        }
        await this.runtimeDeps.authHandoffStore?.transitionLatestActive(scope, "completed", {
          browser_session_id: result.sessionId ?? resolvedSessionId ?? null,
          resumable_session_id: result.sessionId ?? resolvedSessionId ?? null,
        });
        await this.runtimeDeps.circuitBreaker?.recordSuccess(provider.id, scope.serviceKey);
        return this.success({ providerId: provider.id, result }, result.summary, startTime);
      }

      if (result.authRequired && this.runtimeDeps.browserSessionStore) {
        const handoffSessionId = result.sessionId ?? syntheticAuthHandoffSessionId(provider.id, scope);
        const authHandoff = await this.runtimeDeps.authHandoffStore?.createPending({
          providerId: provider.id,
          serviceKey: scope.serviceKey,
          workspace: scope.workspace,
          actorKey: scope.actorKey,
          browserSessionId: handoffSessionId,
          resumableSessionId: result.sessionId ?? null,
          failureCode: result.failureCode ?? null,
          failureMessage: result.error ?? result.summary,
          taskSummary: input.task,
          evidenceRefs: [{
            kind: "tool_result",
            ref: _context.callId ?? "browser_run_workflow",
            observed_at: new Date().toISOString(),
          }],
        });
        await this.runtimeDeps.browserSessionStore.recordAuthRequired({
          sessionId: handoffSessionId,
          providerId: provider.id,
          serviceKey: scope.serviceKey,
          workspace: scope.workspace,
          actorKey: scope.actorKey,
          failureCode: result.failureCode ?? null,
          failureMessage: result.error ?? result.summary,
          metadata: {
            ...(input.startUrl ? { startUrl: input.startUrl } : {}),
            auth_handoff_id: authHandoff?.handoff_id ?? null,
            resumable_session: result.sessionId ?? null,
          },
        });
        const approved = await requestAuthHandoffApproval(_context, provider.id, scope, input.task, handoffSessionId);
        if (!approved) {
          if (authHandoff) {
            await this.runtimeDeps.authHandoffStore?.transition(authHandoff.handoff_id, "cancelled", {
              failure_code: "approval_denied",
              failure_message: "Authentication handoff approval was denied",
            });
          }
          return this.fail(`Authentication handoff denied for ${scope.serviceKey}.`, startTime);
        }
        return {
          success: true,
          data: {
            providerId: provider.id,
            status: "auth_handoff_pending",
            serviceKey: scope.serviceKey,
            authHandoffId: authHandoff?.handoff_id,
            sessionId: handoffSessionId,
            resumableSessionId: result.sessionId,
          },
          summary: `Authentication handoff recorded for ${scope.serviceKey} via ${provider.id}.`,
          contextModifier: buildAuthHandoffContextModifier(provider.id, scope.serviceKey, handoffSessionId, result.sessionId),
          durationMs: Date.now() - startTime,
        };
      }

      if (result.failureCode && this.runtimeDeps.circuitBreaker) {
        await this.runtimeDeps.circuitBreaker.recordFailure({
          providerId: provider.id,
          serviceKey: scope.serviceKey,
          failureCode: result.failureCode,
          failureMessage: result.error ?? result.summary,
        });
      }
      return this.fail(result.error ?? result.summary, startTime);
    } finally {
      await this.runtimeDeps.backpressure?.release(runKey);
    }
  }

  async checkPermissions(input: BrowserRunWorkflowInput): Promise<PermissionCheckResult> {
    return { status: "needs_approval", reason: `Browser workflow requires approval: ${input.task.slice(0, 120)}` };
  }

  isConcurrencySafe(_input: BrowserRunWorkflowInput): boolean {
    return false;
  }

}

function buildBrowserScope(
  providerId: string,
  input: BrowserRunWorkflowInput & { serviceKey?: string },
  context: ToolCallContext,
): BrowserSessionScope {
  const serviceKey = input.serviceKey ?? browserServiceKey(input.startUrl);
  return {
    providerId,
    serviceKey,
    workspace: context.cwd,
    actorKey: context.conversationSessionId ?? context.sessionId ?? context.goalId,
  };
}

function browserServiceKey(startUrl?: string): string {
  if (!startUrl) {
    return "browser_workflow";
  }
  try {
    return new URL(startUrl).hostname.toLowerCase();
  } catch {
    return "browser_workflow";
  }
}

function syntheticAuthHandoffSessionId(providerId: string, scope: BrowserSessionScope): string {
  return `auth-handoff:${providerId}:${scope.serviceKey}:${scope.actorKey}`;
}

function buildAuthHandoffContextModifier(
  providerId: string,
  serviceKey: string,
  sessionId: string,
  resumableSessionId?: string,
): string {
  const resumeTarget = resumableSessionId ?? sessionId;
  const resumeClause = resumableSessionId
    ? `Resume with browser session ${resumeTarget} after login completes.`
    : "The provider did not return a resumable browser session yet; rerun only after a human has completed the login handoff.";
  return `Authentication handoff is pending for ${serviceKey} via ${providerId} in session ${sessionId}. Do not retry this browser workflow until a human completes login. ${resumeClause}`;
}

async function requestAuthHandoffApproval(
  context: ToolCallContext,
  providerId: string,
  scope: BrowserSessionScope,
  task: string,
  sessionId: string,
): Promise<boolean> {
  const request = {
    toolName: "browser_run_workflow",
    input: { providerId, serviceKey: scope.serviceKey, sessionId, task },
    reason: `Authentication handoff required for ${scope.serviceKey} via ${providerId}. Resume browser session ${sessionId} after login.`,
    permissionLevel: "write_remote" as const,
    isDestructive: false,
    reversibility: "unknown" as const,
  };
  await context.onApprovalRequested?.(request);
  return context.approvalFn(request);
}

export class BrowserGetStateTool extends AutomationTool<BrowserGetStateInput> {
  readonly metadata: ToolMetadata = {
    name: "browser_get_state",
    aliases: ["get_browser_state"],
    permissionLevel: "read_only",
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 4,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS, "browser"],
  };
  readonly inputSchema = BrowserGetStateInputSchema;

  constructor(
    registry: InteractiveAutomationRegistry,
    policy: InteractiveAutomationToolPolicy = DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY,
    private readonly runtimeDeps: BrowserWorkflowRuntimeDeps = {},
  ) {
    super(registry, policy);
  }

  description(): string {
    return "Read state from the configured browser automation provider.";
  }

  async call(input: BrowserGetStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    const provider = this.resolveProvider(input, "browser", "browser_control");
    const unavailable = await this.availableOrFail(provider, startTime);
    if (unavailable) return unavailable;
    if (!provider?.getBrowserState) return this.fail(`${provider?.id ?? "provider"} does not support browser state`, startTime);
    const scope = input.serviceKey || input.startUrl
      ? buildBrowserScope(provider.id, { task: "browser_get_state", startUrl: input.startUrl, serviceKey: input.serviceKey }, _context)
      : undefined;
    const resolution = await new BrowserSessionResolver(this.runtimeDeps.browserSessionStore)
      .resolveForState({ scope, sessionId: input.sessionId });
    if (!resolution.ok) {
      return {
        success: false,
        data: {
          providerId: provider.id,
          status: "browser_session_not_executed",
          code: resolution.code,
          sessionId: resolution.sessionId,
        },
        summary: resolution.summary,
        error: resolution.summary,
        durationMs: Date.now() - startTime,
      };
    }
    const result = await provider.getBrowserState({ sessionId: resolution.sessionId });
    return result.success
      ? this.success({ providerId: provider.id, result }, result.summary, startTime)
      : this.fail(result.error ?? result.summary, startTime);
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: BrowserGetStateInput): boolean {
    return true;
  }
}
