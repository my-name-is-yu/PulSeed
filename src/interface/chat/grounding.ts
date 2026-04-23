import type { StateManager } from "../../base/state/state-manager.js";
import { createGroundingGateway, type GroundingGateway } from "../../grounding/gateway.js";
import type { GroundingBundle, GroundingRequest, GroundingSection, GroundingSectionKey } from "../../grounding/contracts.js";
import { pickGroundingSections, renderPromptSections } from "../../grounding/renderers/prompt-renderer.js";
import {
  buildApprovalPolicySectionContent,
  buildExecutionPolicySectionContent,
  buildIdentitySectionContent,
} from "../../grounding/providers/static-policy-provider.js";

export interface GroundingOptions {
  stateManager: StateManager;
  homeDir?: string;
  pluginLoader?: { loadAll(): Promise<Array<{ name: string; enabled?: boolean; error?: string | null }>> };
  workspaceRoot?: string;
  goalId?: string;
  userMessage?: string;
  trustProjectInstructions?: boolean;
  workspaceContext?: string;
}

function createChatGateway(options: Pick<GroundingOptions, "stateManager" | "pluginLoader">): GroundingGateway {
  return createGroundingGateway({
    stateManager: options.stateManager,
    pluginLoader: options.pluginLoader,
  });
}

export { createChatGateway as createChatGroundingGateway };

const CHAT_STATIC_SECTION_KEYS: readonly GroundingSectionKey[] = [
  "identity",
  "execution_policy",
  "approval_policy",
];

const CHAT_DYNAMIC_SECTION_KEYS: readonly GroundingSectionKey[] = [
  "goal_state",
  "plugins",
  "provider_state",
];

const CHAT_DYNAMIC_CONTEXT_INCLUDE: Partial<GroundingRequest["include"]> = {
  identity: false,
  execution_policy: false,
  approval_policy: false,
  trust_state: false,
  repo_instructions: false,
  soil_knowledge: false,
};

function buildChatGroundingRequest(
  options: GroundingOptions,
  overrides: Partial<GroundingRequest> = {},
): GroundingRequest {
  return {
    surface: "chat",
    purpose: "general_turn",
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot,
    goalId: options.goalId,
    userMessage: options.userMessage,
    query: options.userMessage,
    trustProjectInstructions: options.trustProjectInstructions,
    workspaceContext: options.workspaceContext,
    ...overrides,
    ...(overrides.include ? { include: overrides.include } : {}),
  };
}

function renderLegacyStaticPrompt(sections: readonly GroundingSection[]): string {
  return renderPromptSections(sections, {
    omitHeadingKeys: ["execution_policy"],
    preserveOrder: true,
  });
}

function renderLegacyDynamicPrompt(sections: readonly GroundingSection[]): string {
  const byKey = new Map(sections.map((section) => [section.key, section]));
  const goalState = byKey.get("goal_state")?.content ?? "No goals configured yet.";
  const plugins = byKey.get("plugins")?.content?.replace(/^Installed:\s*/, "") ?? "none";
  const provider = byKey.get("provider_state")?.content ?? "not configured";
  return [
    "## Dynamic Context",
    "### Current Goals",
    goalState,
    "",
    "### Installed Plugins",
    `Installed: ${plugins}`,
    "",
    "### Provider",
    provider,
  ].join("\n").trim();
}

export async function buildChatGroundingBundle(
  options: GroundingOptions,
  overrides: Partial<GroundingRequest> = {},
): Promise<GroundingBundle> {
  return await createChatGateway(options).build(buildChatGroundingRequest(options, overrides));
}

export function buildStaticSystemPrompt(): string {
  return [
    `## Identity\n${buildIdentitySectionContent()}`,
    buildExecutionPolicySectionContent(),
    `## Safety And Approval\n${buildApprovalPolicySectionContent()}`,
  ].join("\n\n").trim();
}

export async function buildDynamicContextPrompt(options: GroundingOptions): Promise<string> {
  const bundle = await buildChatGroundingBundle(options, { include: CHAT_DYNAMIC_CONTEXT_INCLUDE });
  return renderLegacyDynamicPrompt(pickGroundingSections(bundle.dynamicSections, CHAT_DYNAMIC_SECTION_KEYS));
}

export async function buildSystemPrompt(options: GroundingOptions): Promise<string> {
  const bundle = await buildChatGroundingBundle(options);
  const staticSections = pickGroundingSections(bundle.staticSections, CHAT_STATIC_SECTION_KEYS);
  const dynamicSections = pickGroundingSections(bundle.dynamicSections, CHAT_DYNAMIC_SECTION_KEYS);
  return [
    renderLegacyStaticPrompt(staticSections),
    renderLegacyDynamicPrompt(dynamicSections),
  ].join("\n\n").trim();
}
