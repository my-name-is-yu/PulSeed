import React from "react";
import { Box, Text } from "ink";
import { getPulseedVersion } from "../../base/utils/pulseed-meta.js";
import { theme } from "./theme.js";
import { statusLabel } from "./dashboard.js";
import { SEEDY_PIXEL } from "./seedy-art.js";

const PULSEED_VERSION = getPulseedVersion(import.meta.url);

export const APP_HEADER_ROWS = SEEDY_PIXEL.split("\n").length;
export const STATUS_BAR_ROWS = 4;

export type DaemonConnectionState = "connected" | "connecting" | "disconnected";

export function formatDaemonConnectionState(state: DaemonConnectionState | undefined): string | undefined {
  if (!state) return undefined;
  return `  [daemon ${state}]`;
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
  cwd,
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
        daemon: {isDaemonMode ? daemonConnectionState ?? "connecting" : "off"}{providerName ? ` · ${providerName}` : ""}
      </Text>
      {cwd && (
        <Text dimColor>{cwd}</Text>
      )}
    </Box>
  </Box>
);

export const StatusBar: React.FC<{
  goalCount: number;
  trustScore: number;
  status: string;
  iteration: number;
  daemonConnectionState?: DaemonConnectionState;
  currentGoalSummary?: string | null;
}> = ({ goalCount, trustScore, status, iteration, daemonConnectionState, currentGoalSummary }) => (
  <Box
    borderStyle="single"
    borderColor={theme.border}
    paddingX={1}
    justifyContent="space-between"
  >
    <Box flexDirection="column" flexGrow={1}>
      <Text dimColor>
        Active: {goalCount}  Trust: {trustScore >= 0 ? "+" : ""}
        {trustScore}  Status: {statusLabel(status)}  Iter: {iteration}
        {formatDaemonConnectionState(daemonConnectionState)}
      </Text>
      {currentGoalSummary && <Text dimColor>{currentGoalSummary}</Text>}
    </Box>
    <Text dimColor>d:dashboard  ?:help  Ctrl-C× 2:quit</Text>
  </Box>
);
