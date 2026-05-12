import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const fullInclude = [
  "src/**/__tests__/**/*.test.ts",
  "plugins/**/__tests__/**/*.test.ts",
  "examples/**/__tests__/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "tests/regression/**/*.test.ts",
  "tests/unit/**/*.test.ts",
  "tests/unit/**/*.spec.ts",
  "tests/test_*.ts",
];

export const contractInclude = [
  "tests/contracts/**/*.test.ts",
];

export const goldenTraceInclude = [
  "tests/golden-traces/**/*.test.ts",
];

export const replayInclude = [
  "tests/replay/**/*.test.ts",
];

export const slowInclude = [
  "tests/slow/**/*.test.ts",
  "tests/test_native_*.ts",
];

export const integrationInclude = [
  "tests/integration/**/*.test.ts",
  "tests/e2e/**/*.test.ts",
  "src/orchestrator/loop/__tests__/core-loop-integrations.test.ts",
  "src/runtime/__tests__/approval-broker.test.ts",
  "src/runtime/__tests__/daemon-client.test.ts",
  "src/runtime/__tests__/daemon-runner.test.ts",
  "src/runtime/__tests__/daemon-runner-approval.test.ts",
  "src/runtime/__tests__/event-file-watcher.test.ts",
  "src/runtime/__tests__/event-server.test.ts",
  "src/runtime/__tests__/event-server-approval.test.ts",
  "src/runtime/__tests__/loop-supervisor.test.ts",
  "src/runtime/__tests__/runtime-evidence-ledger.test.ts",
  "src/runtime/__tests__/schedule-engine.test.ts",
  "src/runtime/__tests__/trigger-api.test.ts",
  "src/runtime/__tests__/watchdog.test.ts",
  "src/runtime/control/**/*.test.ts",
  "src/runtime/daemon/**/*.test.ts",
  "src/runtime/event/**/*.test.ts",
  "src/runtime/gateway/**/*.test.ts",
  "src/runtime/schedule/**/*.test.ts",
  "src/runtime/session-registry/**/*.test.ts",
  "src/interface/chat/__tests__/chat-schedule-integration.test.ts",
  "src/interface/cli/__tests__/cli-daemon-*.test.ts",
  "src/interface/cli/__tests__/cli-runner-integration.test.ts",
  "src/tools/schedule/**/*.test.ts",
  "examples/plugins/sqlite-datasource/**/*.test.ts",
];

export const smokeInclude = [
  "src/runtime/__tests__/watchdog.test.ts",
  "src/runtime/gateway/__tests__/channel-policy.test.ts",
  "src/runtime/queue/__tests__/journal-backed-queue.test.ts",
  "src/interface/cli/__tests__/cli-runner-integration.test.ts",
];

export const integrationPathPrefixes = [
  "tests/integration/",
  "src/runtime/control/",
  "src/runtime/daemon/",
  "src/runtime/event/",
  "src/runtime/gateway/",
  "src/runtime/schedule/",
  "src/runtime/session-registry/",
  "src/tools/schedule/",
  "tests/e2e/",
  "examples/plugins/sqlite-datasource/",
];

export const integrationPathPatterns = [
  /^src\/orchestrator\/loop\/__tests__\/core-loop-integrations\.test\.ts$/,
  /^src\/runtime\/__tests__\/approval-broker\.test\.ts$/,
  /^src\/runtime\/__tests__\/daemon-client\.test\.ts$/,
  /^src\/runtime\/__tests__\/daemon-runner\.test\.ts$/,
  /^src\/runtime\/__tests__\/daemon-runner-approval\.test\.ts$/,
  /^src\/runtime\/__tests__\/event-file-watcher\.test\.ts$/,
  /^src\/runtime\/__tests__\/event-server\.test\.ts$/,
  /^src\/runtime\/__tests__\/event-server-approval\.test\.ts$/,
  /^src\/runtime\/__tests__\/loop-supervisor\.test\.ts$/,
  /^src\/runtime\/__tests__\/runtime-evidence-ledger\.test\.ts$/,
  /^src\/runtime\/__tests__\/schedule-engine\.test\.ts$/,
  /^src\/runtime\/__tests__\/trigger-api\.test\.ts$/,
  /^src\/runtime\/__tests__\/watchdog\.test\.ts$/,
  /^src\/runtime\/schedule\//,
  /^src\/interface\/chat\/__tests__\/chat-schedule-integration\.test\.ts$/,
  /^src\/interface\/cli\/__tests__\/cli-daemon-.*\.test\.ts$/,
  /^src\/interface\/cli\/__tests__\/cli-runner-integration\.test\.ts$/,
];

export const smokePathPatterns = [
  /^src\/runtime\/__tests__\/watchdog\.test\.ts$/,
  /^src\/runtime\/gateway\/__tests__\/channel-policy\.test\.ts$/,
  /^src\/runtime\/queue\/__tests__\/journal-backed-queue\.test\.ts$/,
  /^src\/interface\/cli\/__tests__\/cli-runner-integration\.test\.ts$/,
];

export const sharedCoverage = {
  provider: "v8",
  include: ["src/**/*.ts"],
  exclude: ["src/types/**", "src/tui/**"],
  reporter: ["text", "text-summary", "json", "html"],
  reportsDirectory: "coverage",
};

const dirname = path.dirname(fileURLToPath(import.meta.url));

export const sharedResolve = {
  alias: {
    pulseed: path.resolve(dirname, "src/index.ts"),
  },
};

function normalize(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isIntegrationPath(filePath) {
  const normalized = normalize(filePath);
  return (
    integrationPathPrefixes.some((prefix) => normalized.startsWith(prefix)) ||
    integrationPathPatterns.some((pattern) => pattern.test(normalized))
  );
}

export function isSmokeRelevantPath(filePath) {
  const normalized = normalize(filePath);
  return smokePathPatterns.some((pattern) => pattern.test(normalized));
}
