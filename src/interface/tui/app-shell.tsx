import React from "react";
import { Box, Text } from "ink";
import { getPulseedVersion } from "../../base/utils/pulseed-meta.js";
import { theme } from "./theme.js";
import { SEEDY_PIXEL } from "./seedy-art.js";

const PULSEED_VERSION = getPulseedVersion(import.meta.url);

export const APP_HEADER_ROWS = SEEDY_PIXEL.split("\n").length;
export const STATUS_BAR_ROWS = 4;

export type DaemonConnectionState = "connected" | "connecting" | "disconnected";

export function formatDaemonConnectionState(state: DaemonConnectionState | undefined): string | undefined {
  if (!state) return undefined;
  switch (state) {
    case "connected":
      return "  Background on";
    case "connecting":
      return "  Reconnecting";
    case "disconnected":
      return "  Background disconnected";
  }
}

function formatHeaderReadiness(isDaemonMode: boolean, state: DaemonConnectionState | undefined): string {
  if (!isDaemonMode) return "Ready for local work";
  switch (state) {
    case "connected":
      return "Ready with background work";
    case "disconnected":
      return "Background work disconnected";
    case "connecting":
    default:
      return "Reconnecting background work";
  }
}

function formatDefaultWorkStatus(goalCount: number, status: string): string {
  if (status === "error" || status === "stalled") return "Needs attention";
  if (goalCount > 1) return `${goalCount} active goals`;
  if (goalCount === 1) return status === "running" ? "Working on goal" : "Current goal ready";
  if (status === "running") return "Working";
  return "Ready; no active work";
}

export const AppHeader: React.FC<{
  isDaemonMode: boolean;
  daemonConnectionState?: DaemonConnectionState;
  providerName?: string;
  cwd?: string;
}> = ({
  isDaemonMode,
  daemonConnectionState,
  providerName,
}) => (
  <Box flexDirection="row" paddingY={0}>
    <Box marginRight={2}>
      <Text>{SEEDY_PIXEL}</Text>
    </Box>
    <Box flexDirection="column" justifyContent="center">
      <Box>
        <Text bold color={theme.brand}>PulSeed</Text>
        <Text dimColor> v{PULSEED_VERSION}</Text>
      </Box>
      <Text dimColor>
        {formatHeaderReadiness(isDaemonMode, daemonConnectionState)}
        {providerName ? ` · ${providerName}` : ""}
      </Text>
    </Box>
  </Box>
);

export const StatusBar: React.FC<{
  goalCount: number;
  status: string;
  daemonConnectionState?: DaemonConnectionState;
  currentGoalSummary?: string | null;
}> = ({ goalCount, status, daemonConnectionState, currentGoalSummary }) => (
  <Box
    borderStyle="single"
    borderColor={theme.border}
    paddingX={1}
    justifyContent="space-between"
  >
    <Box flexDirection="column" flexGrow={1}>
      <Text dimColor>
        {formatDefaultWorkStatus(goalCount, status)}
        {formatDaemonConnectionState(daemonConnectionState)}
      </Text>
      {currentGoalSummary && <Text dimColor>{currentGoalSummary}</Text>}
    </Box>
    <Text dimColor>d:dashboard  ?:help  Ctrl-C× 2:quit</Text>
  </Box>
);
