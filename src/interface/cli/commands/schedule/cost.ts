import { parseArgs } from "node:util";
import type { ScheduleEngine } from "../../../../runtime/schedule/engine.js";
import { addUsageTokenCounts } from "../../../usage-counter.js";
import { parseUsagePeriodMs } from "../../../usage-period.js";

export async function scheduleCost(engine: ScheduleEngine, argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        period: { type: "string", default: "7d" },
      },
      strict: false,
    });
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  let periodMs: number;
  const period = String(parsed.values.period ?? "7d");
  try {
    periodMs = parseUsagePeriodMs(period);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  const sinceMs = Date.now() - periodMs;
  const history = (await engine.getRecentHistory(5000))
    .filter((record) => new Date(record.finished_at).getTime() >= sinceMs);
  const entries = engine.getEntries();
  const byEntry = new Map<string, { name: string; layer: string; executions: number; tokens: number }>();

  for (const entry of entries) {
    byEntry.set(entry.id, {
      name: entry.name,
      layer: entry.layer,
      executions: 0,
      tokens: 0,
    });
  }

  for (const record of history) {
    const current = byEntry.get(record.entry_id) ?? {
      name: record.entry_name,
      layer: record.layer ?? "unknown",
      executions: 0,
      tokens: 0,
    };
    current.executions += 1;
    current.tokens = addUsageTokenCounts(current.tokens, record.tokens_used ?? 0);
    byEntry.set(record.entry_id, current);
  }

  const rows = Array.from(byEntry.entries())
    .map(([entryId, row]) => ({ entryId, ...row }))
    .filter((row) => row.executions > 0 || row.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens || left.name.localeCompare(right.name));
  const totalTokens = rows.reduce((sum, row) => addUsageTokenCounts(sum, row.tokens), 0);
  const totalExecutions = rows.reduce((sum, row) => sum + row.executions, 0);

  console.log(`Schedule cost summary (${period})`);
  console.log(`  executions: ${totalExecutions}`);
  console.log(`  tokens:     ${totalTokens}`);

  if (rows.length === 0) {
    console.log("  no schedule executions in this period");
    return 0;
  }

  for (const row of rows) {
    console.log(
      `  ${row.entryId.slice(0, 8)}  [${row.layer}] ${row.name}  executions=${row.executions}  tokens=${row.tokens}`
    );
  }
  return 0;
}
