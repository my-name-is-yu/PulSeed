import { SearchOrchestrator } from "../orchestrator.js";
import { evaluateFixture } from "./metrics.js";
import { CODE_SEARCH_EVAL_FIXTURES, fixtureToTask } from "./fixtures.js";

export async function runCodeSearchEval(cwd: string = process.cwd()): Promise<ReturnType<typeof evaluateFixture>[]> {
  const orchestrator = new SearchOrchestrator(cwd);
  const results = [];
  for (const fixture of CODE_SEARCH_EVAL_FIXTURES) {
    const candidates = await orchestrator.search(fixtureToTask(fixture, cwd));
    results.push(evaluateFixture(fixture, candidates));
  }
  return results;
}
