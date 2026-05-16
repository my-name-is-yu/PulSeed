import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import {
  inspectUserMemory,
  parseMemoryCorrectionRef,
  runUserMemoryOperation,
  UserMemoryOperationSchema,
  type UserMemoryOperation,
} from "../../../platform/corrections/user-memory-operations.js";
import type { UserFacingMemoryInspectProjection } from "../../../platform/corrections/memory-inspect-projection.js";

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function hasOption(argv: string[], name: string): boolean {
  return argv.indexOf(name) >= 0;
}

function printUsage(): void {
  getCliLogger().error("Usage: pulseed memory <correct|forget|retract|history> <kind:id> ... | pulseed memory inspect <kind:id> [--json] | pulseed memory export [--consent-scope id] [--include-secret]");
}

function printInspectProjection(projection: UserFacingMemoryInspectProjection): void {
  console.log("Memory inspection:");
  console.log(`  Target type:           ${projection.target_kind.replace(/_/g, " ")}`);
  console.log(`  Current state:         ${projection.current_state}`);
  console.log(`  Active for future use: ${projection.active_for_future_use ? "yes" : "no"}`);
  console.log(`  Replacement recorded:  ${projection.replacement_recorded ? "yes" : "no"}`);
  console.log(`  Physical delete:       ${projection.physical_delete_performed ? "performed" : "not performed"}`);
  console.log(`  Raw content visible:   ${projection.raw_content_visible ? "yes" : "no"}`);
  if (projection.history.length === 0) {
    console.log("  History:               No correction entries found.");
    return;
  }
  console.log("  History:");
  for (const entry of projection.history) {
    console.log(`    - ${entry.occurred_at} ${entry.action}`);
    console.log(`      effect: ${entry.user_visible_effect}`);
    console.log(`      replacement recorded: ${entry.replacement_recorded ? "yes" : "no"}`);
    console.log(`      reason recorded: ${entry.reason_recorded ? "yes" : "no"}`);
  }
}

export async function cmdMemory(stateManager: StateManager, argv: string[]): Promise<number> {
  if (argv[0] === "export") {
    const manager = new KnowledgeManager(stateManager, {} as ILLMClient);
    const entries = await manager.exportAgentMemoryGovernance({
      consent_scope: optionValue(argv, "--consent-scope"),
      include_secret: hasOption(argv, "--include-secret"),
    });
    console.log(JSON.stringify({ entries }, null, 2));
    return 0;
  }

  if (argv[0] === "inspect") {
    const refValue = argv[1];
    if (!refValue) {
      printUsage();
      return 1;
    }
    if (hasOption(argv, "--destructive-delete")) {
      getCliLogger().error("Destructive memory deletion requires a separate explicit approval flow; inspect is read-only.");
      return 1;
    }
    try {
      const projection = await inspectUserMemory(stateManager, {
        targetRef: parseMemoryCorrectionRef(refValue),
        goalId: optionValue(argv, "--goal"),
        runId: optionValue(argv, "--run"),
        taskId: optionValue(argv, "--task"),
      });
      if (hasOption(argv, "--json")) {
        console.log(JSON.stringify(projection, null, 2));
      } else {
        printInspectProjection(projection);
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("memory inspect", err));
      return 1;
    }
  }

  const operation = argv[0] as UserMemoryOperation | undefined;
  const refValue = argv[1];
  if (!operation || !UserMemoryOperationSchema.safeParse(operation).success || !refValue) {
    printUsage();
    return 1;
  }
  if (hasOption(argv, "--destructive-delete")) {
    getCliLogger().error("Destructive memory deletion requires a separate explicit approval flow; use forget/retract for the default auditable path.");
    return 1;
  }

  try {
    const targetRef = parseMemoryCorrectionRef(refValue);
    const replacementRefValue = optionValue(argv, "--replacement-ref");
    const result = await runUserMemoryOperation(stateManager, {
      operation,
      targetRef,
      reason: optionValue(argv, "--reason"),
      replacementValue: optionValue(argv, "--value"),
      replacementKey: optionValue(argv, "--replacement-key"),
      replacementRef: replacementRefValue ? parseMemoryCorrectionRef(replacementRefValue) : null,
      goalId: optionValue(argv, "--goal"),
      runId: optionValue(argv, "--run"),
      taskId: optionValue(argv, "--task"),
    });

    if (operation === "history") {
      console.log(`Correction history for ${refValue}:`);
      if (result.history.length === 0) {
        console.log("  No correction entries found.");
        return 0;
      }
      for (const entry of result.history) {
        console.log(`  ${entry.created_at} ${entry.correction_kind} ${entry.correction_id}`);
        console.log(`    reason: ${entry.reason}`);
        if (entry.replacement_ref) {
          console.log(`    replacement: ${entry.replacement_ref.kind}:${entry.replacement_ref.id}`);
        }
      }
      return 0;
    }

    console.log(`Memory ${operation} recorded: ${result.correction?.correction_id}`);
    console.log(`Target: ${result.target_ref.kind}:${result.target_ref.id}`);
    if (result.replacement) {
      console.log(`Replacement: ${result.replacement.ref.kind}:${result.replacement.ref.id}`);
    }
    return 0;
  } catch (err) {
    getCliLogger().error(formatOperationError(`memory ${operation}`, err));
    return 1;
  }
}
