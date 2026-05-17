import type {
  CompanionCognitionOutput,
  ModelContextPolicy,
} from "./contracts.js";

export function renderCompanionCognitionGatewaySystemPrompt(
  basePrompt: string,
  cognition: Pick<CompanionCognitionOutput, "model_context_policy">,
): string {
  const policy = cognition.model_context_policy;
  if (!policy || policy.surface !== "gateway_chat") return basePrompt;
  return [
    basePrompt,
    renderReplyShape(policy),
    renderLocalFactPolicy(policy),
    renderToolUsePolicy(policy),
    renderInternalLabelPolicy(policy),
    renderRuntimeControlPolicy(policy),
    renderLanguagePolicy(policy.language_policy),
  ].filter((section) => section.trim().length > 0).join("\n\n");
}

function renderReplyShape(policy: ModelContextPolicy): string {
  if (policy.reply_shape !== "codex_chat_shape") return "";
  return "You are Seedy on a gateway chat surface. Match Codex's chat shape: answer ordinary casual messages directly, and choose tools only when current state, setup, run-spec, implementation handoff, or inspection work is actually needed.";
}

function renderLocalFactPolicy(policy: ModelContextPolicy): string {
  if (policy.local_fact_policy !== "tool_required_for_current_state") return "";
  return "Do not invent current workspace, runtime, command, process, repository, file, or local-machine facts. If you need those facts, call an available tool first.";
}

function renderToolUsePolicy(policy: ModelContextPolicy): string {
  if (policy.tool_use_policy !== "use_available_tools_for_inspection_or_state") return "";
  return [
    "Default gateway tool contract: when the user explicitly asks to inspect current repository files, workspace state, PulSeed runtime/gateway/daemon/session state, setup state, or implementation status, use the relevant available tool before answering.",
    "Do not answer tool-available inspection requests by telling the user to run local commands or manual checks themselves. If the relevant tool is unavailable, denied, or insufficient, say that plainly and keep the answer bounded to what was actually checked.",
  ].join("\n\n");
}

function renderInternalLabelPolicy(policy: ModelContextPolicy): string {
  if (policy.internal_label_visibility !== "suppress_route_and_lifecycle_labels") return "";
  return "When using tools, write brief model-authored commentary only when it helps the user understand the real next step. Do not describe route selection, lifecycle phases, or internal PulSeed planning labels.";
}

function renderRuntimeControlPolicy(policy: ModelContextPolicy): string {
  if (policy.runtime_control_policy !== "provided_authorization_tools_only") return "";
  return "Keep PulSeed runtime-control actions behind the provided authorization and approval tools. Do not suggest shell commands as a workaround for unauthorized runtime control.";
}

function renderLanguagePolicy(policy: ModelContextPolicy["language_policy"]): string {
  const base = "Reply in the same language as the user's current input. Do not translate command names, slash commands, file paths, config keys, environment variables, protocol tokens, or code.";
  if (policy.hint === "ja") {
    return `${base} The current turn language hint is Japanese, so user-facing prose should be Japanese.`;
  }
  if (policy.hint === "latin") {
    return `${base} The current turn uses Latin script, but the exact language is not known; infer the user's language from the current message instead of defaulting to English.`;
  }
  if (policy.hint === "other") {
    return `${base} The current turn is not Japanese or Latin script; infer the user's language from the current message instead of defaulting to English or Japanese.`;
  }
  return base;
}
