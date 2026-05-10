import type { StateManager } from "../../base/state/state-manager.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { EthicsGate } from "./ethics-gate.js";
import type { StallDetector } from "../drive/stall-detector.js";
import type { DriveSystem } from "../drive/drive-system.js";
import type { VectorIndex } from "../knowledge/vector-index.js";
import type { KnowledgeTransfer } from "../knowledge/transfer/knowledge-transfer.js";
import type { TransferCandidate } from "../../base/types/cross-portfolio.js";
import type { Goal } from "../../base/types/goal.js";
import { CuriosityStateStore, type CuriosityStateStorePort } from "../../runtime/store/curiosity-state-store.js";
import {
  CuriosityStateSchema,
  CuriosityProposalSchema,
  CuriosityConfigSchema,
  LearningRecordSchema,
} from "../../base/types/curiosity.js";
import type {
  CuriosityState,
  CuriosityTrigger,
  CuriosityProposal,
  CuriosityConfig,
  LearningRecord,
} from "../../base/types/curiosity.js";
import {
  computeProposalHash,
  generateProposals as generateProposalsImpl,
} from "./curiosity-proposals.js";
import {
  detectSemanticTransfer as detectSemanticTransferImpl,
  detectKnowledgeTransferOpportunities as detectKnowledgeTransferOpportunitiesImpl,
} from "./curiosity-transfer.js";
import type { SemanticTransferEvidence } from "./curiosity-transfer.js";
import {
  evaluateCuriosityTriggers,
  shouldExploreForCuriosity,
} from "./curiosity-triggers.js";

// ─── Deps Interface ───

export interface CuriosityEngineDeps {
  stateManager: StateManager;
  curiosityStateStore?: CuriosityStateStorePort;
  llmClient: ILLMClient;
  ethicsGate: EthicsGate;
  stallDetector: StallDetector;
  driveSystem: DriveSystem;
  vectorIndex?: VectorIndex;  // Phase 2: embedding-based detection
  knowledgeTransfer?: KnowledgeTransfer;  // Stage 14F: cross-goal transfer detection
  config?: Partial<CuriosityConfig>;
}

// ─── CuriosityEngine ───

/**
 * CuriosityEngine implements Stage 11C (Curiosity MVP).
 *
 * It acts as a meta-orchestrator: while the 3 drive forces (dissatisfaction,
 * deadline, opportunity) select tasks within existing goals, CuriosityEngine
 * proposes new goals or goal restructurings based on learning feedback.
 *
 * Key responsibilities:
 * - Evaluate 5 trigger conditions (§2 of curiosity.md)
 * - Generate LLM-based proposals, filtered by ethics gate
 * - Track proposal lifecycle (pending → approved/rejected/expired/auto_closed)
 * - Enforce constraints: max proposals, rejection cooldown, resource budget
 * - Persist all state through the typed curiosity runtime state store
 */
export class CuriosityEngine {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly ethicsGate: EthicsGate;
  private readonly stallDetector: StallDetector;
  private readonly driveSystem: DriveSystem;
  private readonly curiosityStateStore: CuriosityStateStorePort;
  private readonly vectorIndex?: VectorIndex;
  private readonly knowledgeTransfer?: KnowledgeTransfer;
  private readonly config: CuriosityConfig;
  private state: CuriosityState;

  constructor(deps: CuriosityEngineDeps) {
    this.stateManager = deps.stateManager;
    this.llmClient = deps.llmClient;
    this.ethicsGate = deps.ethicsGate;
    this.stallDetector = deps.stallDetector;
    this.driveSystem = deps.driveSystem;
    this.curiosityStateStore =
      deps.curiosityStateStore ?? new CuriosityStateStore(this.stateManager.getBaseDir());
    this.vectorIndex = deps.vectorIndex;
    this.knowledgeTransfer = deps.knowledgeTransfer;

    // Merge user config with defaults
    this.config = CuriosityConfigSchema.parse(deps.config ?? {});

    // Initialize with empty state; actual state is loaded asynchronously via ensureStateLoaded()
    this.state = CuriosityStateSchema.parse({
      proposals: [],
      learning_records: [],
      last_exploration_at: null,
      rejected_proposal_hashes: [],
    });
    this._stateLoaded = false;
  }

  private _stateLoaded: boolean;

  private async ensureStateLoaded(): Promise<void> {
    if (!this._stateLoaded) {
      this.state = await this.loadState();
      this._stateLoaded = true;
    }
  }

  // ─── State Persistence ───

  private async loadState(): Promise<CuriosityState> {
    try {
      const raw = await this.curiosityStateStore.load();
      if (raw === null) {
        return CuriosityStateSchema.parse({
          proposals: [],
          learning_records: [],
          last_exploration_at: null,
          rejected_proposal_hashes: [],
        });
      }
      return CuriosityStateSchema.parse(raw);
    } catch {
      // Corrupt state — start fresh
      return CuriosityStateSchema.parse({
        proposals: [],
        learning_records: [],
        last_exploration_at: null,
        rejected_proposal_hashes: [],
      });
    }
  }

  private saveState(): void {
    const parsed = CuriosityStateSchema.parse(this.state);
    this.curiosityStateStore.saveSync(parsed);
  }

  // ─── Public API ───

  /**
   * Evaluate all 5 trigger conditions against current goal state.
   * Returns an array of fired triggers (may be empty if none fire).
   */
  async evaluateTriggers(goals: Goal[]): Promise<CuriosityTrigger[]> {
    if (!this.config.enabled) return [];
    await this.ensureStateLoaded();
    return evaluateCuriosityTriggers(goals, {
      config: this.config,
      stallDetector: this.stallDetector,
      state: this.state,
    });
  }

  /**
   * Generate curiosity proposals using the LLM, filtered by ethics gate.
   *
   * - Respects max_active_proposals limit (skips generation if at capacity)
   * - Skips proposals in rejection cooldown
   * - Runs ethics check on each proposal before adding
   * - Updates last_exploration_at on any periodic_exploration trigger
   * - Saves state after mutation
   */
  async generateProposals(
    triggers: CuriosityTrigger[],
    goals: Goal[],
    options: { relationshipProfileContext?: string } = {}
  ): Promise<CuriosityProposal[]> {
    await this.ensureStateLoaded();
    const activeProposals = this.getActiveProposals();

    const newProposals = await generateProposalsImpl(
      triggers,
      goals,
      this.state,
      activeProposals.length,
      {
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        vectorIndex: this.vectorIndex,
        knowledgeTransfer: this.knowledgeTransfer,
        config: this.config,
      },
      {
        relationshipProfileContext: options.relationshipProfileContext,
      }
    );

    this.saveState();
    return newProposals;
  }

  /**
   * Approve a pending proposal by ID.
   * Sets status to "approved" and records reviewed_at.
   * Throws if proposal is not found or not in "pending" status.
   */
  approveProposal(proposalId: string): CuriosityProposal {
    const index = this.state.proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
      throw new Error(
        `CuriosityEngine.approveProposal: proposal "${proposalId}" not found`
      );
    }

    const proposal = this.state.proposals[index]!;
    if (proposal.status !== "pending") {
      throw new Error(
        `CuriosityEngine.approveProposal: proposal "${proposalId}" is not pending (status=${proposal.status})`
      );
    }

    const updated = CuriosityProposalSchema.parse({
      ...proposal,
      status: "approved",
      reviewed_at: new Date().toISOString(),
    });

    this.state.proposals[index] = updated;
    this.saveState();
    return updated;
  }

  /**
   * Reject a pending proposal by ID.
   * Sets status to "rejected", records reviewed_at, and sets rejection_cooldown_until.
   * Also adds the proposal hash to rejected_proposal_hashes for cooldown tracking.
   * Throws if proposal is not found or not in "pending" status.
   */
  rejectProposal(proposalId: string): CuriosityProposal {
    const index = this.state.proposals.findIndex((p) => p.id === proposalId);
    if (index === -1) {
      throw new Error(
        `CuriosityEngine.rejectProposal: proposal "${proposalId}" not found`
      );
    }

    const proposal = this.state.proposals[index]!;
    if (proposal.status !== "pending") {
      throw new Error(
        `CuriosityEngine.rejectProposal: proposal "${proposalId}" is not pending (status=${proposal.status})`
      );
    }

    const now = new Date();
    const cooldownUntil = new Date(
      now.getTime() +
        this.config.rejection_cooldown_hours * 60 * 60 * 1000
    );

    const updated = CuriosityProposalSchema.parse({
      ...proposal,
      status: "rejected",
      reviewed_at: now.toISOString(),
      rejection_cooldown_until: cooldownUntil.toISOString(),
    });

    this.state.proposals[index] = updated;

    // Track hash for cooldown deduplication
    const hash = computeProposalHash(proposal.proposed_goal.description);
    if (!this.state.rejected_proposal_hashes.includes(hash)) {
      this.state.rejected_proposal_hashes.push(hash);
    }

    this.saveState();
    return updated;
  }

  /**
   * Expire pending proposals past their expires_at date, and auto-close
   * approved proposals that have reached the unproductive_loop_limit.
   *
   * Returns the list of proposals that were changed in this call.
   */
  checkAutoExpiration(): CuriosityProposal[] {
    const now = new Date();
    const changed: CuriosityProposal[] = [];

    this.state.proposals = this.state.proposals.map((p) => {
      // Expire pending proposals past expires_at
      if (p.status === "pending" && new Date(p.expires_at) <= now) {
        const updated = CuriosityProposalSchema.parse({
          ...p,
          status: "expired",
        });
        changed.push(updated);
        return updated;
      }

      // Auto-close approved proposals at or past the unproductive loop limit
      if (
        p.status === "approved" &&
        p.loop_count >= this.config.unproductive_loop_limit
      ) {
        const updated = CuriosityProposalSchema.parse({
          ...p,
          status: "auto_closed",
        });
        changed.push(updated);
        return updated;
      }

      return p;
    });

    if (changed.length > 0) {
      this.saveState();
    }

    return changed;
  }

  /**
   * Increment loop_count for an approved curiosity proposal identified by its goal_id.
   * No-op if no matching proposal is found.
   */
  incrementLoopCount(goalId: string): void {
    let changed = false;

    this.state.proposals = this.state.proposals.map((p) => {
      if (p.status === "approved" && p.goal_id === goalId) {
        changed = true;
        return CuriosityProposalSchema.parse({
          ...p,
          loop_count: p.loop_count + 1,
        });
      }
      return p;
    });

    if (changed) {
      this.saveState();
    }
  }

  /**
   * Add a learning record to state and persist.
   * Automatically sets recorded_at to now.
   */
  recordLearning(record: Omit<LearningRecord, "recorded_at">): void {
    const full = LearningRecordSchema.parse({
      ...record,
      recorded_at: new Date().toISOString(),
    });
    this.state.learning_records.push(full);
    this.saveState();
  }

  /**
   * Return all proposals with status "pending" or "approved".
   */
  getActiveProposals(): CuriosityProposal[] {
    return this.state.proposals.filter(
      (p) => p.status === "pending" || p.status === "approved"
    );
  }

  /**
   * Quick check: are there any triggers that warrant curiosity?
   * Used by DurableLoop to decide whether to run full evaluateTriggers.
   *
   * Returns true if:
   * - Curiosity is enabled
   * - Any of the quick-check conditions are met (task queue empty,
   *   periodic exploration overdue, or any stall state detected)
   */
  async shouldExplore(goals: Goal[]): Promise<boolean> {
    if (!this.config.enabled) return false;
    await this.ensureStateLoaded();
    return shouldExploreForCuriosity(goals, {
      config: this.config,
      stallDetector: this.stallDetector,
      state: this.state,
    });
  }

  // ─── Phase 2: Embedding-based Detection ───

  /**
   * Index a dimension name into the VectorIndex for semantic search.
   * Silently skips if no vectorIndex is configured.
   */
  async indexDimensionToVector(goalId: string, dimensionName: string): Promise<void> {
    if (!this.vectorIndex) return;
    await this.vectorIndex.add(
      `dim:${goalId}:${dimensionName}`,
      dimensionName,
      { goal_id: goalId, type: "dimension" }
    );
  }

  /**
   * Find semantically similar dimensions across other goals using VectorIndex.
   * Returns up to 3 results with similarity > 0.7. Returns [] if no vectorIndex.
   */
  async findSimilarDimensions(
    goalId: string,
    dimName: string
  ): Promise<Array<{ id: string; similarity: number; goal_id: string }>> {
    if (!this.vectorIndex) return [];
    const results = await this.vectorIndex.search(dimName, 3, 0.7);
    return results
      .filter((r) => (r.metadata.goal_id as string) !== goalId)
      .map((r) => ({ id: r.id, similarity: r.similarity, goal_id: r.metadata.goal_id as string }));
  }

  /**
   * Detect semantically similar dimensions across goals using VectorIndex.
   * Returns cross-goal transfers with similarity > 0.7.
   */
  async detectSemanticTransfer(
    goalId: string,
    dimensions: string[]
  ): Promise<SemanticTransferEvidence[]> {
    return detectSemanticTransferImpl(goalId, dimensions, {
      vectorIndex: this.vectorIndex,
    });
  }

  // ─── Stage 14F: KnowledgeTransfer Integration ───

  /**
   * Detect cross-goal knowledge transfer opportunities for all active goals.
   * Requires knowledgeTransfer to be injected — returns [] otherwise.
   *
   * For each active goal, calls KnowledgeTransfer.detectTransferOpportunities()
   * and converts the resulting TransferCandidates into a flat list.
   * Results are suggestion-only (Phase 1); no transfers are applied automatically.
   */
  async detectKnowledgeTransferOpportunities(
    goals: Goal[]
  ): Promise<TransferCandidate[]> {
    return detectKnowledgeTransferOpportunitiesImpl(goals, {
      knowledgeTransfer: this.knowledgeTransfer,
    });
  }

  /**
   * Calculate the allowed resource percentage for curiosity goals based on
   * the current state of user goals.
   *
   * Returns:
   *   - 100 (no limit) if all user goals are completed
   *   - waiting_user_goals_max_percent if all user goals are waiting
   *   - active_user_goals_max_percent if any user goals are active
   *   - 0 if curiosity is disabled
   */
  getResourceBudget(goals: Goal[]): number {
    if (!this.config.enabled) return 0;

    const allUserGoals = goals.filter((g) => g.origin !== "curiosity");

    if (allUserGoals.length === 0) {
      // No user goals — unlimited curiosity budget
      return 100;
    }

    const allCompleted = allUserGoals.every((g) => g.status === "completed");
    if (allCompleted) {
      return 100;
    }

    const allWaiting = allUserGoals.every(
      (g) => g.status === "completed" || g.status === "waiting"
    );
    if (allWaiting) {
      return this.config.resource_budget.waiting_user_goals_max_percent;
    }

    // Some goals are active — limited budget
    return this.config.resource_budget.active_user_goals_max_percent;
  }
}
