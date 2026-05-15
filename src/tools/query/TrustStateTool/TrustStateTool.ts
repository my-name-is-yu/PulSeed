import { z } from "zod/v3";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { TrustStateStore, type TrustStateStorePort } from "../../../runtime/store/trust-state-store.js";
import { HIGH_TRUST_THRESHOLD } from "../../../platform/traits/types/trust.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const TrustStateInputSchema = z.object({
  adapterId: z.string().optional(),
}).strict();
export type TrustStateInput = z.infer<typeof TrustStateInputSchema>;

export class TrustStateTool implements ITool<TrustStateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "trust_state",
    aliases: ["get_trust_state", "observe_trust"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = TrustStateInputSchema;

  private trustStateStore: TrustStateStorePort | null;

  constructor(private readonly stateManager: StateManager, trustStateStore?: TrustStateStorePort) {
    this.trustStateStore = trustStateStore ?? null;
  }

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TrustStateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const store = await this.getTrustStateStore().loadStore();

      if (input.adapterId) {
        return this._singleAdapter(input.adapterId, store, startTime);
      }
      return this._allAdapters(store, startTime);
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TrustStateTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private _singleAdapter(adapterId: string, store: Awaited<ReturnType<TrustStateStorePort["loadStore"]>>, startTime: number): ToolResult {
    const balance = store.balances[adapterId] ?? { domain: adapterId, balance: 0, success_delta: 3, failure_delta: -10 };
    const recentEvents = (store.override_log ?? [])
      .filter((e) => e.domain === adapterId)
      .slice(-10)
      .map((e) => ({
        delta: e.balance_after != null && e.balance_before != null ? e.balance_after - e.balance_before : null,
        reason: e.override_type,
        timestamp: e.timestamp,
      }));

    return {
      success: true,
      data: {
        adapterId,
        balance: balance.balance,
        highTrust: balance.balance >= HIGH_TRUST_THRESHOLD,
        recentEvents,
      },
      summary: `Adapter "${adapterId}": balance=${balance.balance}, highTrust=${balance.balance >= HIGH_TRUST_THRESHOLD}`,
      durationMs: Date.now() - startTime,
    };
  }

  private _allAdapters(store: Awaited<ReturnType<TrustStateStorePort["loadStore"]>>, startTime: number): ToolResult {
    const adapters = Object.values(store.balances).map((b) => ({
      adapterId: b.domain,
      balance: b.balance,
      highTrust: b.balance >= HIGH_TRUST_THRESHOLD,
    }));

    return {
      success: true,
      data: { adapters },
      summary: `${adapters.length} adapter trust state(s) found`,
      durationMs: Date.now() - startTime,
    };
  }

  async checkPermissions(_input: TrustStateInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: TrustStateInput): boolean {
    return true;
  }

  private getTrustStateStore(): TrustStateStorePort {
    this.trustStateStore ??= new TrustStateStore(this.stateManager.getBaseDir());
    return this.trustStateStore;
  }
}
