type RestartRuntimeControlKind = "restart_daemon" | "restart_gateway";

export function runtimeControlRestartRequestedMessage(kind: RestartRuntimeControlKind): string {
  return kind === "restart_gateway"
    ? "Gateway restart request was sent to the daemon. PulSeed will verify recovery after the daemon restarts."
    : "PulSeed daemon restart request was sent. PulSeed will verify recovery through the watchdog.";
}

export function runtimeControlRestartVerifiedMessage(kind: RestartRuntimeControlKind): string {
  return kind === "restart_gateway"
    ? "Gateway restart was verified."
    : "PulSeed daemon restart was verified.";
}
