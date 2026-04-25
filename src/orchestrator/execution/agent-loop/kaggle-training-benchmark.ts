export interface KaggleTrainingBenchmarkSignals {
  experimentStarted: boolean;
  logArtifactWritten: boolean;
  metricsParsed: boolean;
  bestSelectedByDirection: boolean;
  waitResumedAfterProcessExit: boolean;
  restartReadsArtifacts: boolean;
  noSubmitCalled: boolean;
}

export interface KaggleTrainingBenchmarkCase {
  name: string;
  run: () => Promise<KaggleTrainingBenchmarkSignals>;
}

export interface KaggleTrainingBenchmarkCaseResult {
  name: string;
  signals: KaggleTrainingBenchmarkSignals;
  passed: boolean;
  reasons: string[];
}

export interface KaggleTrainingBenchmarkSummary {
  totalCases: number;
  passedCases: number;
  passRate: number;
  ready: boolean;
  reasons: string[];
  results: KaggleTrainingBenchmarkCaseResult[];
}

export const kaggleTrainingBenchmarkRequiredTools = [
  "kaggle_workspace_prepare",
  "kaggle_experiment_start",
  "kaggle_experiment_read",
  "kaggle_experiment_list",
  "kaggle_metric_report",
  "kaggle_compare_experiments",
] as const;

export function scoreKaggleTrainingSignals(
  signals: KaggleTrainingBenchmarkSignals,
): { passed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!signals.experimentStarted) reasons.push("experiment metadata and process metadata were not created");
  if (!signals.logArtifactWritten) reasons.push("train.log was not written as a durable artifact");
  if (!signals.metricsParsed) reasons.push("metrics.json was not parsed and schema-validated");
  if (!signals.bestSelectedByDirection) reasons.push("best experiment was not selected using metric direction");
  if (!signals.waitResumedAfterProcessExit) reasons.push("wait did not resume after process exit");
  if (!signals.restartReadsArtifacts) reasons.push("restart-time read did not recover from artifacts");
  if (!signals.noSubmitCalled) reasons.push("submit was called during the training benchmark");
  return { passed: reasons.length === 0, reasons };
}

export async function runKaggleTrainingBenchmark(
  cases: readonly KaggleTrainingBenchmarkCase[],
): Promise<KaggleTrainingBenchmarkSummary> {
  const results: KaggleTrainingBenchmarkCaseResult[] = [];
  for (const benchmarkCase of cases) {
    const signals = await benchmarkCase.run();
    const score = scoreKaggleTrainingSignals(signals);
    results.push({
      name: benchmarkCase.name,
      signals,
      passed: score.passed,
      reasons: score.reasons,
    });
  }
  const totalCases = results.length;
  const passedCases = results.filter((result) => result.passed).length;
  const passRate = totalCases === 0 ? 0 : passedCases / totalCases;
  const reasons = results
    .filter((result) => !result.passed)
    .map((result) => `${result.name}: ${result.reasons.join("; ")}`);
  return {
    totalCases,
    passedCases,
    passRate,
    ready: reasons.length === 0,
    reasons,
    results,
  };
}

