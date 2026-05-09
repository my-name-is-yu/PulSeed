// ─── pulseed approval commands (read-only) ───

import * as path from "node:path";
import { parseArgs } from "node:util";

import type { StateManager } from "../../../base/state/state-manager.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { type ApprovalRecord } from "../../../runtime/store/runtime-schemas.js";
import { createRuntimeStorePaths } from "../../../runtime/store/runtime-paths.js";
import type { RuntimeStorePaths } from "../../../runtime/store/runtime-paths.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

function createApprovalContext(stateManager: StateManager): {
  approvalStore: ApprovalStore;
  paths: RuntimeStorePaths;
} {
  const runtimeRoot = path.join(stateManager.getBaseDir(), "runtime");
  const paths = createRuntimeStorePaths(runtimeRoot);
  return { approvalStore: new ApprovalStore(paths, { controlBaseDir: stateManager.getBaseDir() }), paths };
}

const ID_WIDTH = 14;
const GOAL_WIDTH = 14;
const STATE_WIDTH = 12;
const DATE_WIDTH = 24;
const CHANNEL_WIDTH = 24;

function formatCell(value: string | undefined, maxLen: number): string {
  const normalized = (value ?? "-").replace(/\s+/g, " ").trim() || "-";
  return normalized.length > maxLen ? `${normalized.slice(0, maxLen - 3)}...` : normalized;
}

function dateLabel(value?: number): string {
  return value === undefined ? "-" : new Date(value).toISOString();
}

function printApprovalRows(records: ApprovalRecord[], showResolved: boolean): void {
  if (showResolved) {
    console.log(
      `${"ID".padEnd(ID_WIDTH)} ${"GOAL".padEnd(GOAL_WIDTH)} ${"STATE".padEnd(STATE_WIDTH)} ${"CREATED".padEnd(DATE_WIDTH)} ${"RESOLVED".padEnd(DATE_WIDTH)} CHANNEL`
    );
    console.log("-".repeat(100));
    for (const record of records) {
      console.log(
        `${formatCell(record.approval_id, ID_WIDTH).padEnd(ID_WIDTH)} ${formatCell(record.goal_id, GOAL_WIDTH).padEnd(GOAL_WIDTH)} ${record.state.padEnd(STATE_WIDTH)} ${dateLabel(record.created_at).padEnd(DATE_WIDTH)} ${dateLabel(record.resolved_at).padEnd(DATE_WIDTH)} ${formatCell(record.response_channel, CHANNEL_WIDTH)}`
      );
    }
    return;
  }

  console.log(
    `${"ID".padEnd(ID_WIDTH)} ${"GOAL".padEnd(GOAL_WIDTH)} ${"STATE".padEnd(STATE_WIDTH)} ${"CREATED".padEnd(DATE_WIDTH)} ${"EXPIRES".padEnd(DATE_WIDTH)} CHANNEL`
  );
  console.log("-".repeat(100));
  for (const record of records) {
    console.log(
      `${formatCell(record.approval_id, ID_WIDTH).padEnd(ID_WIDTH)} ${formatCell(record.goal_id, GOAL_WIDTH).padEnd(GOAL_WIDTH)} ${record.state.padEnd(STATE_WIDTH)} ${dateLabel(record.created_at).padEnd(DATE_WIDTH)} ${dateLabel(record.expires_at).padEnd(DATE_WIDTH)} ${formatCell(record.response_channel, CHANNEL_WIDTH)}`
    );
  }
}

export async function cmdApprovalList(stateManager: StateManager, args: string[]): Promise<number> {
  const logger = getCliLogger();
  let values: { resolved?: boolean };

  try {
    ({ values } = parseArgs({
      args,
      options: {
        resolved: { type: "boolean" },
      },
      strict: false,
    }) as { values: { resolved?: boolean } });
  } catch (err) {
    logger.error(formatOperationError("parse approval list arguments", err));
    values = {};
  }

  const showResolved = values.resolved === true;
  const { approvalStore } = createApprovalContext(stateManager);

  let approvals: ApprovalRecord[];
  try {
    approvals = showResolved ? await approvalStore.listResolved() : await approvalStore.listPending();
  } catch (err) {
    logger.error(formatOperationError("load approval records", err));
    return 1;
  }

  const label = showResolved ? "resolved" : "pending";
  if (approvals.length === 0) {
    console.log(`No ${label} approvals found.`);
    return 0;
  }

  const sorted = [...approvals].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.approval_id.localeCompare(b.approval_id);
  });

  console.log(`${showResolved ? "Resolved" : "Pending"} approvals:\n`);
  printApprovalRows(sorted, showResolved);
  console.log(`\nTotal: ${sorted.length} approval(s)`);

  return 0;
}
