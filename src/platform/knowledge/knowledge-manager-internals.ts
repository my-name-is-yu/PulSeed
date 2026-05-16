import * as path from "node:path";
import type { StateManager } from "../../base/state/state-manager.js";
import type { DomainKnowledge, SharedKnowledgeEntry } from "../../base/types/knowledge.js";
import {
  projectAgentMemoryToSoil,
  projectDomainKnowledgeToSoil,
  projectSharedKnowledgeToSoil,
  rebuildSoilIndex,
} from "../soil/index.js";
import {
  AgentMemoryStoreSchema,
  type AgentMemoryStore,
} from "./types/agent-memory.js";
import { KnowledgeMemoryStateStore } from "./knowledge-memory-state-store.js";
import {
  loadAgentMemoryStoreFromTruth,
  loadDomainKnowledgeFromTruth,
  loadSharedKnowledgeFromTruth,
  saveAgentMemoryStoreToTruth,
  saveDomainKnowledgeToTruth,
  saveSharedKnowledgeToTruth,
} from "./memory-truth-adapter.js";

export function knowledgeMemoryStoreForStateManager(stateManager: StateManager): KnowledgeMemoryStateStore {
  return new KnowledgeMemoryStateStore(stateManager.getBaseDir());
}

export async function loadAgentMemoryStore(stateManager: StateManager): Promise<AgentMemoryStore> {
  const baseDir = stateManager.getBaseDir();
  const truth = AgentMemoryStoreSchema.parse(await loadAgentMemoryStoreFromTruth(baseDir));
  if (truth.entries.length > 0 || truth.corrections.length > 0) return truth;
  const legacy = AgentMemoryStoreSchema.parse(await knowledgeMemoryStoreForStateManager(stateManager).loadAgentMemoryStore());
  if (legacy.entries.length > 0 || legacy.corrections.length > 0) {
    await saveAgentMemoryStoreToTruth(baseDir, legacy);
  }
  return legacy;
}

export async function saveAgentMemoryStore(stateManager: StateManager, store: AgentMemoryStore): Promise<void> {
  await saveAgentMemoryStoreToTruth(stateManager.getBaseDir(), store);
  await projectAgentMemory(stateManager, store);
}

export async function projectDomainKnowledge(stateManager: StateManager, goalId: string, domainKnowledge: DomainKnowledge): Promise<void> {
  try {
    const baseDir = stateManager.getBaseDir();
    await projectDomainKnowledgeToSoil({ baseDir, goalId, domainKnowledge });
    await knowledgeMemoryStoreForStateManager(stateManager).saveDomainKnowledge(domainKnowledge);
    await rebuildSoilIndex({ rootDir: path.join(baseDir, "soil") });
  } catch (error) {
    console.warn(
      `[soil] Failed to project domain knowledge for ${goalId}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function projectSharedKnowledge(stateManager: StateManager, entries: SharedKnowledgeEntry[]): Promise<void> {
  try {
    const baseDir = stateManager.getBaseDir();
    await projectSharedKnowledgeToSoil({ baseDir, entries });
    await knowledgeMemoryStoreForStateManager(stateManager).saveSharedKnowledgeEntries(entries);
    await rebuildSoilIndex({ rootDir: path.join(baseDir, "soil") });
  } catch (error) {
    console.warn(
      `[soil] Failed to project shared knowledge: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function projectAgentMemory(stateManager: StateManager, store: AgentMemoryStore): Promise<void> {
  try {
    const baseDir = stateManager.getBaseDir();
    await projectAgentMemoryToSoil({ baseDir, store });
    await knowledgeMemoryStoreForStateManager(stateManager).saveAgentMemoryStore(store);
    await rebuildSoilIndex({ rootDir: path.join(baseDir, "soil") });
  } catch (error) {
    console.warn(
      `[soil] Failed to project agent memory: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function loadDomainKnowledgeFromOwner(stateManager: StateManager, goalId: string): Promise<DomainKnowledge> {
  const baseDir = stateManager.getBaseDir();
  const truth = await loadDomainKnowledgeFromTruth(baseDir, goalId);
  if (truth.entries.length > 0) return truth;
  const legacy = await knowledgeMemoryStoreForStateManager(stateManager).loadDomainKnowledge(goalId);
  if (legacy.entries.length > 0) {
    await saveDomainKnowledgeToTruth(baseDir, legacy);
  }
  return legacy;
}

export async function saveDomainKnowledgeToOwner(stateManager: StateManager, domainKnowledge: DomainKnowledge): Promise<void> {
  await saveDomainKnowledgeToTruth(stateManager.getBaseDir(), domainKnowledge);
}

export async function loadSharedKnowledgeFromOwner(stateManager: StateManager): Promise<SharedKnowledgeEntry[]> {
  const baseDir = stateManager.getBaseDir();
  const truth = await loadSharedKnowledgeFromTruth(baseDir);
  if (truth.length > 0) return truth;
  const legacy = await knowledgeMemoryStoreForStateManager(stateManager).loadSharedKnowledgeEntries();
  if (legacy.length > 0) {
    await saveSharedKnowledgeToTruth(baseDir, legacy);
  }
  return legacy;
}

export async function saveSharedKnowledgeToOwner(stateManager: StateManager, entries: SharedKnowledgeEntry[]): Promise<void> {
  await saveSharedKnowledgeToTruth(stateManager.getBaseDir(), entries);
}
