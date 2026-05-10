import type { FailureRecoverySignal } from "./failure-recovery.js";
import type { SeedyTurnPresence } from "./seedy-turn-presence.js";
import type { TurnLanguageHint } from "./turn-language.js";

export interface ChatEventContext {
  runId: string;
  turnId: string;
  languageHint?: TurnLanguageHint;
}

export interface ActiveChatTurn {
  context: ChatEventContext;
  cwd: string;
  startedAt: number;
  abortController: AbortController;
  finished: Promise<void>;
  resolveFinished: () => void;
  recentEvents: string[];
  recentFailureSignals: FailureRecoverySignal[];
  interruptRequested: boolean;
  seedyPresence?: SeedyTurnPresence;
}
