// ─── Tool Metadata ───
//
// Rich metadata for config keys and mutation tools. Injected into LLM tool
// descriptions so the LLM can generate thorough explanations before acting.

// ─── Config Key Metadata (unchanged) ───

export interface ConfigKeyMeta {
  label: string;
  description: string;
  type: "boolean" | "number" | "string" | "object";
  effects: string[];
  requirements: string[];
  risks: string[];
  revert: string;
  appliesAt: "next_session" | "immediate";
  requiresExplicitApproval?: boolean;
}

export const CONFIG_METADATA: Record<string, ConfigKeyMeta> = {
  daemon_mode: {
    label: "Daemon Mode",
    description: "Runs the goal runtime through a background daemon process.",
    type: "boolean",
    effects: [
      "The daemon keeps eligible goals running in the background.",
      "Goal execution can continue after the TUI is closed.",
      "The TUI can reconnect as a client window.",
      "Multiple clients, including the TUI and notification channels, can observe the daemon at the same time.",
    ],
    requirements: [
      "A machine that stays awake while the daemon is expected to run.",
      "Port 41700 must be available unless configured otherwise.",
      "Recommended on a dedicated agent machine.",
    ],
    risks: [
      "Background goal execution may continue calling LLM APIs and incur ongoing cost.",
      "The daemon must be stopped explicitly with pulseed daemon stop.",
      "If the machine sleeps, the daemon may stop and require a restart.",
    ],
    revert: "Run pulseed config set daemon_mode false, or turn it off from /settings in the TUI.",
    appliesAt: "next_session",
    requiresExplicitApproval: true,
  },
  no_flicker: {
    label: "No Flicker UI",
    description: "Reduces terminal flicker by throttling TUI redraw behavior.",
    type: "boolean",
    effects: [
      "Changes how the TUI redraws terminal output.",
      "May reduce visible flicker on some terminals.",
    ],
    requirements: [
      "Use during a TUI session.",
    ],
    risks: [
      "Some terminals may show no noticeable difference.",
    ],
    revert: "pulseed config set no_flicker false",
    appliesAt: "immediate",
    requiresExplicitApproval: false,
  },
  interactive_automation: {
    label: "Interactive Automation",
    description: "Desktop, browser, and research automation provider settings",
    type: "object",
    effects: [
      "PulSeed can route selected tasks to configured desktop, browser, and research automation providers",
      "Desktop and browser mutation tools can interact with local or remote user interfaces",
      "Research tools can call a configured research provider for sourced answers",
    ],
    requirements: [
      "Provider credentials or host bridges must be configured before non-noop providers become available",
      "Desktop providers may require local app accessibility permissions",
    ],
    risks: [
      "Misconfigured GUI automation can click, type, or submit data in the wrong application",
      "Remote research or browser providers may send task content to third-party services",
    ],
    revert: "pulseed config set interactive_automation '{\"enabled\":false}'",
    appliesAt: "next_session",
    requiresExplicitApproval: true,
  },
};

export function configChangeRequiresApproval(key: string): boolean {
  return CONFIG_METADATA[key]?.requiresExplicitApproval ?? false;
}

/** Build a rich description string for a single config key. */
export function buildConfigKeyDescription(key: string): string {
  const m = CONFIG_METADATA[key];
  if (!m) return `Unknown config key: ${key}`;
  const bullet = (arr: string[]) => arr.map(s => `- ${s}`).join("\n");
  const timing = m.appliesAt === "next_session" ? "Applies from the next session or restart." : "Applies immediately.";
  const approval = m.requiresExplicitApproval ? "Explicit user confirmation is required." : "Usually safe to change immediately.";
  return [`## ${m.label} (${key})`, m.description, "", "### Effects", bullet(m.effects), "",
    "### Requirements", bullet(m.requirements), "", "### Risks", bullet(m.risks), "",
    "### Revert", m.revert, "", "### Applies", timing, "",
    "### Approval", approval].join("\n");
}

/** Build the full tool description with all config keys' metadata injected. */
export function buildConfigToolDescription(): string {
  const descs = Object.keys(CONFIG_METADATA).map(k => buildConfigKeyDescription(k)).join("\n\n---\n\n");
  return ["Change PulSeed configuration.", "",
    "Important rules before calling this tool:",
    "1. Explain the setting's effects, requirements, risks, revert path, and apply timing.",
    "2. For settings that require explicit user confirmation, obtain consent before calling the tool.",
    "3. For low-risk settings, provide a concise explanation before applying the change.",
    "4. If the runtime requests additional approval, follow that approval flow.", "",
    "Available configuration keys:", "", descs].join("\n");
}

// ─── Mutation Tool Metadata (generic) ───

export interface MutationToolMeta {
  label: string;
  description: string;
  effects: string[];
  risks: string[];
  revert: string;
}

export const MUTATION_TOOL_METADATA: Record<string, MutationToolMeta> = {
  delete_goal: {
    label: "Delete Goal",
    description: "Permanently removes a goal and all associated state (observations, trust scores, session history)",
    effects: [
      "Goal and all children are permanently deleted",
      "Active agent sessions for this goal are terminated",
      "If daemon is running, the goal is removed from the active loop immediately",
      "Historical observation data is lost",
    ],
    risks: [
      "Cannot be undone — goal ID cannot be reused",
      "If the goal has running sessions, they will be force-terminated",
      "Child goals are also deleted recursively",
    ],
    revert: "Goal must be re-created manually with set_goal. Historical data cannot be recovered.",
  },
};

/** Build a rich description string for a mutation tool. */
export function buildMutationToolDescription(toolName: string): string {
  const m = MUTATION_TOOL_METADATA[toolName];
  if (!m) return `Unknown mutation tool: ${toolName}`;
  const bullet = (arr: string[]) => arr.map(s => `- ${s}`).join("\n");
  return [
    `## ${m.label}`,
    m.description, "",
    "Important: before calling this tool, do all of the following:",
    "1. Describe the exact target and expected impact.",
    "2. List the risks.",
    "3. State that this operation cannot be undone.",
    "4. Obtain explicit user confirmation.",
    "Do not call this tool until the user confirms.", "",
    "### Effects", bullet(m.effects), "",
    "### Risks", bullet(m.risks), "",
    "### Recovery", m.revert,
  ].join("\n");
}
