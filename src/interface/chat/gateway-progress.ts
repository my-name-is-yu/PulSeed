export type GatewayProgressAudience = "user" | "diagnostic" | "internal";

export type GatewayProgressPhase =
  | "checking"
  | "planning"
  | "running_tool"
  | "editing"
  | "testing"
  | "waiting"
  | "blocked"
  | "finalizing";

export type GatewayProgressImportance =
  | "heartbeat"
  | "milestone"
  | "action_required"
  | "blocked";

export type GatewayProgressVerbosity =
  | "silent"
  | "summary"
  | "detailed"
  | "verbose";

export interface GatewayPublicProgress {
  readonly audience: GatewayProgressAudience;
  readonly phase: GatewayProgressPhase;
  readonly importance: GatewayProgressImportance;
  readonly verbosity: GatewayProgressVerbosity;
  readonly subject: string;
  readonly reason?: string;
  readonly lastActivityAt?: string;
  readonly lastActivityLabel?: string;
  readonly elapsedMs?: number;
  readonly diagnosticRef?: string;
}
