import type { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { SessionManager } from "../session-manager.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import type { Task } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { TaskDomain } from "../../../base/types/pipeline.js";
import type { AdapterRegistry } from "../adapter-layer.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import type { Logger } from "../../../runtime/logger.js";

export type SelectTargetDimensionFn = (
  gapVector: GapVector,
  driveContext: DriveContext,
  dimensions?: Dimension[]
) => string;

export type GenerateTaskFn = (
  goalId: string,
  targetDimension: string,
  strategyId: string | undefined,
  knowledgeContext?: string,
  adapterType?: string,
  existingTasks?: string[],
  workspaceContext?: string
) => Promise<Task | null>;

export interface PipelineCycleOptions {
  knowledgeContext?: string;
  existingTasks?: string[];
  workspaceContext?: string;
  observationEngine?: ObservationEngine;
  domain?: TaskDomain;
  adapterRegistry?: AdapterRegistry;
}

export interface PipelineCycleDeps {
  stateManager: StateManager;
  sessionManager: SessionManager;
  llmClient: ILLMClient;
  ethicsGate?: EthicsGate;
  capabilityDetector?: CapabilityDetector;
  approvalFn: (task: Task) => Promise<boolean>;
  adapterRegistry?: AdapterRegistry;
  logger?: Logger;
  knowledgeManager?: KnowledgeManager;
  checkIrreversibleApproval: (task: Task) => Promise<boolean>;
  selectTargetDimension: SelectTargetDimensionFn;
  generateTask: GenerateTaskFn;
}
