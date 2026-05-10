import type { StateManager } from "../../../base/state/state-manager.js";
import {
  TransferTrustScoreSchema,
} from "../../../base/types/cross-portfolio.js";
import type { TransferTrustScore } from "../../../base/types/cross-portfolio.js";
import type { TransferEffectiveness } from "../../../base/types/cross-portfolio.js";
import {
  TransferTrustStateStore,
  type TransferTrustStateStorePort,
} from "../../../runtime/store/transfer-trust-state-store.js";

/** How many recent outcomes to store for shouldInvalidate check */
const HISTORY_WINDOW = 3;

/**
 * TransferTrustManager tracks per-domain-pair trust scores for transfer candidates.
 *
 * Trust starts at 0.5 (neutral). Positive outcomes raise it; negative outcomes lower it.
 * After HISTORY_WINDOW consecutive non-positive outcomes, shouldInvalidate returns true.
 *
 * Persistence: typed transfer trust runtime state store.
 */
export class TransferTrustManager {
  private readonly stateManager: StateManager;
  private transferTrustStateStore: TransferTrustStateStorePort | null;

  constructor(deps: { stateManager: StateManager; transferTrustStateStore?: TransferTrustStateStorePort }) {
    this.stateManager = deps.stateManager;
    this.transferTrustStateStore = deps.transferTrustStateStore ?? null;
  }

  private store(): TransferTrustStateStorePort {
    this.transferTrustStateStore ??= new TransferTrustStateStore(this.stateManager.getBaseDir());
    return this.transferTrustStateStore;
  }

  /** Return the trust score record for a domain pair, creating a default if absent. */
  async getTrustScore(domainPair: string): Promise<TransferTrustScore> {
    try {
      const score = await this.store().loadScore(domainPair);
      if (score !== null) return score;
    } catch {
      // non-fatal: return default
    }
    return this._defaultScore(domainPair);
  }

  /**
   * Update trust score based on a transfer effectiveness outcome.
   * - positive: trust_score += 0.1 (clamped to 1.0), success_count++
   * - negative: trust_score -= 0.15 (clamped to 0.0), failure_count++
   * - neutral: neutral_count++ (no score change)
   */
  async updateTrust(
    domainPair: string,
    effectiveness: TransferEffectiveness
  ): Promise<TransferTrustScore> {
    const current = await this.getTrustScore(domainPair);

    let newScore = current.trust_score;
    const update: Partial<TransferTrustScore> = {};

    if (effectiveness === "positive") {
      newScore = Math.min(1.0, newScore + 0.1);
      update.success_count = current.success_count + 1;
    } else if (effectiveness === "negative") {
      newScore = Math.max(0.0, newScore - 0.15);
      update.failure_count = current.failure_count + 1;
    } else {
      update.neutral_count = current.neutral_count + 1;
    }

    const updated = TransferTrustScoreSchema.parse({
      ...current,
      ...update,
      trust_score: newScore,
      last_updated: new Date().toISOString(),
    });

    await this.store().saveScore(updated);

    // Append to history
    await this._appendHistory(domainPair, effectiveness);

    return updated;
  }

  /**
   * Returns true if the last HISTORY_WINDOW outcomes are all non-positive
   * (negative or neutral), indicating the domain pair should be invalidated.
   */
  async shouldInvalidate(domainPair: string): Promise<boolean> {
    const history = await this._getHistory(domainPair);
    if (history.length < HISTORY_WINDOW) {
      return false;
    }
    const recent = history.slice(-HISTORY_WINDOW);
    return recent.every((e) => e !== "positive");
  }

  /** Return all stored trust score records. */
  async getAllScores(): Promise<TransferTrustScore[]> {
    try {
      const scores = await this.store().listScores();
      const seenDomainPairs = new Set(scores.map((score) => score.domain_pair));
      const indexDomainPairs = await this.store().listIndexDomainPairs();
      for (const domainPair of indexDomainPairs) {
        if (!seenDomainPairs.has(domainPair)) {
          scores.push(this._defaultScore(domainPair));
        }
      }
      return scores;
    } catch {
      return [];
    }
  }

  // ─── Private Helpers ───

  private _defaultScore(domainPair: string): TransferTrustScore {
    return TransferTrustScoreSchema.parse({
      domain_pair: domainPair,
      success_count: 0,
      failure_count: 0,
      neutral_count: 0,
      trust_score: 0.5,
      last_updated: new Date().toISOString(),
    });
  }

  private async _getHistory(domainPair: string): Promise<TransferEffectiveness[]> {
    try {
      return await this.store().loadHistory(domainPair);
    } catch {
      // non-fatal
    }
    return [];
  }

  private async _appendHistory(
    domainPair: string,
    effectiveness: TransferEffectiveness
  ): Promise<void> {
    const history = await this._getHistory(domainPair);
    history.push(effectiveness);
    // Keep only the last HISTORY_WINDOW * 2 entries to bound file size
    const trimmed = history.slice(-(HISTORY_WINDOW * 2));
    try {
      await this.store().saveHistory(domainPair, trimmed);
    } catch {
      // non-fatal
    }
  }
}
