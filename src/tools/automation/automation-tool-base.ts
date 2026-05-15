import type { z } from "zod/v3";
import type {
  InteractiveAutomationCapability,
  InteractiveAutomationProviderFamily,
} from "../../runtime/interactive-automation/types.js";
import type { InteractiveAutomationRegistry } from "../../runtime/interactive-automation/registry.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";

export const TAGS = ["automation", "interactive"];
export const MAX_OUTPUT_CHARS = 12_000;

const DEFAULT_DENIED_APPS = ["Password Manager", "Banking", "System Settings"];

export interface InteractiveAutomationToolPolicy {
  requireApproval: "always" | "write" | "destructive";
  allowedApps?: readonly string[];
  deniedApps?: readonly string[];
}

export const DEFAULT_INTERACTIVE_AUTOMATION_TOOL_POLICY: InteractiveAutomationToolPolicy = {
  requireApproval: "always",
  deniedApps: DEFAULT_DENIED_APPS,
};

export abstract class AutomationTool<TInput> implements ITool<TInput> {
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

  protected resolveProvider(
    input: { providerId?: string },
    family: InteractiveAutomationProviderFamily,
    capability: InteractiveAutomationCapability,
  ) {
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

  protected async availableOrFail(
    provider: { id: string; isAvailable: () => Promise<{ available: boolean; reason?: string }> } | undefined,
    startTime: number
  ): Promise<ToolResult | null> {
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
