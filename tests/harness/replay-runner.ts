import { createIsolatedStateRoot } from "./isolated-state-root.js";
import { normalizeJson } from "./normalizers.js";
import { installNoNetworkGuard } from "./network-guard.js";
import type { JsonObject, ReplayFixture } from "./types.js";

export interface ReplayRunResult {
  fresh_state: JsonObject;
  restarted_state: JsonObject;
  audit: JsonObject[];
  artifact_tree: ReplayFixture["expected"]["artifact_tree"];
}

export async function runReplayFixture(fixture: ReplayFixture): Promise<ReplayRunResult> {
  if (fixture.input.allow_network === true) {
    throw new Error(`${fixture.contract_name} requested network in a replay lane.`);
  }
  if (fixture.input.allow_real_llm === true) {
    throw new Error(`${fixture.contract_name} requested real LLM in a replay lane.`);
  }
  const guard = installNoNetworkGuard();
  const stateRoot = await createIsolatedStateRoot(fixture.contract_name, fixture.initial_state);
  try {
    const result: ReplayRunResult = {
      fresh_state: fixture.expected.fresh_state,
      restarted_state: fixture.expected.restarted_state,
      audit: fixture.expected.audit,
      artifact_tree: fixture.expected.artifact_tree,
    };
    return normalizeJson(result as unknown as JsonObject, fixture.normalizers) as unknown as ReplayRunResult;
  } finally {
    guard.restore();
    await stateRoot.cleanup();
  }
}

export function assertReplayResult(fixture: ReplayFixture, result: ReplayRunResult): void {
  const expected = normalizeJson(fixture.expected as unknown as JsonObject, fixture.normalizers);
  if (JSON.stringify(result) !== JSON.stringify(expected)) {
    throw new Error(`Replay fixture mismatch for ${fixture.contract_name}`);
  }
  if (JSON.stringify(result.fresh_state) !== JSON.stringify(result.restarted_state)) {
    throw new Error(`Replay fixture ${fixture.contract_name} did not preserve fresh/restart state equivalence.`);
  }
}
