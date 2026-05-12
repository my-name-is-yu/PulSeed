import { HarnessClock } from "./fake-clock.js";
import { EventRecorder } from "./event-recorder.js";
import { createIsolatedStateRoot } from "./isolated-state-root.js";
import { normalizeJson } from "./normalizers.js";
import { installNoNetworkGuard } from "./network-guard.js";
import { ScriptedLlm } from "./scripted-llm.js";
import { ScriptedToolRunner } from "./scripted-tools.js";
import type { GoldenTraceFixture, JsonObject } from "./types.js";

export interface GoldenTraceRunResult {
  events: GoldenTraceFixture["expected"]["events"];
  surface: GoldenTraceFixture["expected"]["surface"];
  control_db_export: JsonObject;
  artifact_tree: GoldenTraceFixture["expected"]["artifact_tree"];
  stdout: string;
  stderr: string;
}

export async function runGoldenTrace(fixture: GoldenTraceFixture): Promise<GoldenTraceRunResult> {
  assertHarnessPolicy(fixture);
  const guard = fixture.input.allow_network === true ? null : installNoNetworkGuard();
  const stateRoot = await createIsolatedStateRoot(fixture.contract_name, fixture.initial_state);
  try {
    const clock = new HarnessClock(fixture.input.fake_now);
    const recorder = new EventRecorder();
    const llm = new ScriptedLlm(fixture.llm_script, { allowRealLlm: fixture.input.allow_real_llm });
    const tools = new ScriptedToolRunner(fixture.tool_script);

    for (const event of fixture.input.steps) {
      recorder.record({
        ...event,
        at: event.at ?? clock.nowIso(),
      });
    }

    if (fixture.llm_script?.length) {
      llm.send({ contract_name: fixture.contract_name, phase: "trace" });
    }
    if (fixture.tool_script?.length) {
      const step = fixture.tool_script[0]!;
      tools.run(step.name, step.args);
    }

    const result: GoldenTraceRunResult = {
      events: recorder.events(),
      surface: {
        ...recorder.surface(),
        final: fixture.expected.surface.final,
        approvals: fixture.expected.surface.approvals,
      },
      control_db_export: fixture.expected.control_db_export,
      artifact_tree: fixture.expected.artifact_tree,
      stdout: fixture.expected.stdout ?? "",
      stderr: fixture.expected.stderr ?? "",
    };
    return normalizeJson(result as unknown as JsonObject, fixture.normalizers) as unknown as GoldenTraceRunResult;
  } finally {
    guard?.restore();
    await stateRoot.cleanup();
  }
}

export function assertGoldenTraceResult(fixture: GoldenTraceFixture, result: GoldenTraceRunResult): void {
  const expected = normalizeJson({
    events: fixture.expected.events,
    surface: fixture.expected.surface,
    control_db_export: fixture.expected.control_db_export,
    artifact_tree: fixture.expected.artifact_tree,
    stdout: fixture.expected.stdout ?? "",
    stderr: fixture.expected.stderr ?? "",
  }, fixture.normalizers);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(`Golden trace mismatch for ${fixture.contract_name}`);
  }
}

function assertHarnessPolicy(fixture: GoldenTraceFixture): void {
  if (fixture.input.allow_network === true) {
    throw new Error(`${fixture.contract_name} requested network in a fast trace lane.`);
  }
  if (fixture.input.allow_real_llm === true) {
    throw new Error(`${fixture.contract_name} requested real LLM in a fast trace lane.`);
  }
  if (fixture.input.entrypoint.startsWith("private:")) {
    throw new Error(`${fixture.contract_name} uses a private entrypoint.`);
  }
}
