/**
 * slot-definitions.ts
 * Purpose-specific slot configurations for the PromptGateway.
 * Defines context slots, memory layers, budget categories, and per-purpose configs.
 */

// ─── Core Types ──────────────────────────────────────────────────────────────

export type ContextPurpose =
  | "observation"
  | "task_generation"
  | "verification"
  | "strategy_generation"
  | "goal_decomposition";

export type ContextSlot =
  | "goal_definition"
  | "current_state"
  | "dimension_history"
  | "recent_task_results"
  | "reflections"
  | "lessons"
  | "knowledge"
  | "strategy_templates"
  | "workspace_state"
  | "failure_context";

export type MemoryLayer = "hot" | "warm" | "cold" | "archival";

export type BudgetCategory =
  | "goalDefinition"
  | "observations"
  | "knowledge"
  | "transferKnowledge"
  | "meta";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface SlotDefinition {
  slot: ContextSlot;
  layer: MemoryLayer;
  xmlTag: string;
  /** Lower value = higher priority (used for budget trimming) */
  priority: number;
}

export interface PurposeSlotConfig {
  purpose: ContextPurpose;
  activeSlots: ContextSlot[];
  budgetOverrides?: Partial<Record<BudgetCategory, number>>;
}

// ─── Default Budget Allocations (percentages) ────────────────────────────────

export const DEFAULT_BUDGET: Record<BudgetCategory, number> = {
  goalDefinition: 20,
  observations: 30,
  knowledge: 30,
  transferKnowledge: 15,
  meta: 5,
};

// ─── Slot Definitions ────────────────────────────────────────────────────────

const SLOT_DEFINITIONS: SlotDefinition[] = [
  { slot: "goal_definition",      layer: "hot",      xmlTag: "goal_definition",      priority: 1 },
  { slot: "current_state",        layer: "hot",      xmlTag: "current_state",         priority: 2 },
  { slot: "dimension_history",    layer: "warm",     xmlTag: "dimension_history",     priority: 5 },
  { slot: "recent_task_results",  layer: "warm",     xmlTag: "recent_task_results",   priority: 4 },
  { slot: "reflections",          layer: "warm",     xmlTag: "reflections",           priority: 6 },
  { slot: "lessons",              layer: "cold",     xmlTag: "lessons",               priority: 7 },
  { slot: "knowledge",            layer: "archival", xmlTag: "knowledge",             priority: 8 },
  { slot: "strategy_templates",   layer: "archival", xmlTag: "strategy_templates",    priority: 9 },
  { slot: "workspace_state",      layer: "warm",     xmlTag: "workspace_state",       priority: 3 },
  { slot: "failure_context",      layer: "warm",     xmlTag: "failure_context",       priority: 10 },
];

const SLOT_DEFINITION_MAP = new Map<ContextSlot, SlotDefinition>(
  SLOT_DEFINITIONS.map((d) => [d.slot, d])
);

// ─── Purpose → Active Slots (slot matrix §5.2) ───────────────────────────────

const PURPOSE_SLOT_CONFIGS: PurposeSlotConfig[] = [
  {
    purpose: "observation",
    activeSlots: [
      "goal_definition",
      "current_state",
      "dimension_history",
      "workspace_state",
    ],
    budgetOverrides: {
      observations: 40,
      knowledge: 15,
    },
  },
  {
    purpose: "task_generation",
    activeSlots: [
      "goal_definition",
      "current_state",
      "recent_task_results",
      "reflections",
      "lessons",
      "knowledge",
      "workspace_state",
      "failure_context",
    ],
    budgetOverrides: {
      knowledge: 35,
      observations: 25,
    },
  },
  {
    purpose: "verification",
    activeSlots: [
      "goal_definition",
      "current_state",
      "recent_task_results",
      "knowledge",
    ],
    budgetOverrides: {
      observations: 35,
      knowledge: 25,
    },
  },
  {
    purpose: "strategy_generation",
    activeSlots: [
      "goal_definition",
      "current_state",
      "lessons",
      "knowledge",
      "strategy_templates",
    ],
    budgetOverrides: {
      knowledge: 40,
      transferKnowledge: 20,
      observations: 15,
      goalDefinition: 20,
      meta: 5,
    },
  },
  {
    purpose: "goal_decomposition",
    activeSlots: [
      "goal_definition",
      "knowledge",
    ],
    budgetOverrides: {
      goalDefinition: 30,
      knowledge: 35,
      observations: 15,
      transferKnowledge: 15,
      meta: 5,
    },
  },
];

const PURPOSE_CONFIG_MAP = new Map<ContextPurpose, PurposeSlotConfig>(
  PURPOSE_SLOT_CONFIGS.map((c) => [c.purpose, c])
);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the slot configuration (active slots + budget overrides) for a given purpose.
 * Throws if the purpose is not registered (should never happen with the union type).
 */
export function getSlotConfig(purpose: ContextPurpose): PurposeSlotConfig {
  const config = PURPOSE_CONFIG_MAP.get(purpose);
  if (!config) {
    throw new Error(`No slot config registered for purpose: ${purpose}`);
  }
  return config;
}

/**
 * Returns the full SlotDefinition for a given slot name.
 * Throws if the slot is not registered.
 */
export function getSlotDefinition(slot: ContextSlot): SlotDefinition {
  const def = SLOT_DEFINITION_MAP.get(slot);
  if (!def) {
    throw new Error(`No slot definition registered for slot: ${slot}`);
  }
  return def;
}
