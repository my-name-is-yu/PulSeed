const REPETITIVE_WINDOW = 3;
const SIMILARITY_THRESHOLD = 0.8;
const NO_CHANGE_PATTERNS = ["no changes made", "no modifications", "nothing to change", "no action taken"];
const TEXT_FALLBACK_MAX_CONFIDENCE = 0.6;

export interface StallTaskHistoryEntry {
  strategy_id: string | null;
  output: string;
  task_result?: StallTaskResultEvidence;
}

export interface StallTaskResultEvidence {
  changed_files?: string[];
  diff_stats?: {
    files_changed?: number;
    insertions?: number;
    deletions?: number;
  };
  tool_calls?: Array<{
    tool_name: string;
    status?: "success" | "failed" | "skipped";
  }>;
  verification_status?: "passed" | "failed" | "not_run" | "unknown";
  artifact_changes?: Array<{
    artifact_id: string;
    change_type: "created" | "updated" | "deleted";
  }>;
}

export interface RepetitivePatternResult {
  isRepetitive: boolean;
  pattern: "identical_actions" | "oscillating" | "no_change" | null;
  confidence: number;
  source?: "typed_task_result" | "text_fallback" | "none";
}

function stringSimilarity(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) {
    return 0;
  }

  const getBigrams = (value: string): string[] => {
    const bigrams: string[] = [];
    for (let index = 0; index < value.length - 1; index += 1) {
      bigrams.push(value.slice(index, index + 2));
    }
    return bigrams;
  };

  const bigramsA = getBigrams(a);
  const bigramsB = getBigrams(b);
  if (bigramsA.length === 0 || bigramsB.length === 0) {
    return 0;
  }

  const counts = new Map<string, number>();
  for (const bigram of bigramsB) {
    counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  }

  let intersection = 0;
  for (const bigram of bigramsA) {
    const count = counts.get(bigram) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(bigram, count - 1);
    }
  }

  return (2 * intersection) / (bigramsA.length + bigramsB.length);
}

export function detectRepetitivePatterns(taskHistory: StallTaskHistoryEntry[]): RepetitivePatternResult {
  if (taskHistory.length < REPETITIVE_WINDOW) {
    return { isRepetitive: false, pattern: null, confidence: 0, source: "none" };
  }

  const recent = taskHistory.slice(-REPETITIVE_WINDOW);
  const outputs = recent.map((entry) => entry.output);
  const typedEvidence = recent.map((entry) => entry.task_result).filter((result) => result !== undefined);
  const anyMaterialChange = recent.some((entry) => hasMaterialTaskChange(entry));
  if (anyMaterialChange) {
    return { isRepetitive: false, pattern: null, confidence: 0, source: "typed_task_result" };
  }

  if (typedEvidence.length === REPETITIVE_WINDOW) {
    const allNoOp = recent.every((entry) => hasTypedNoOpEvidence(entry));
    if (allNoOp) {
      return { isRepetitive: true, pattern: "no_change", confidence: 0.9, source: "typed_task_result" };
    }
  }

  const noChangeCount = recent.filter((entry) =>
    NO_CHANGE_PATTERNS.some((pattern) => entry.output.toLowerCase().includes(pattern))
  ).length;
  if (noChangeCount >= REPETITIVE_WINDOW) {
    return { isRepetitive: true, pattern: "no_change", confidence: TEXT_FALLBACK_MAX_CONFIDENCE, source: "text_fallback" };
  }

  const strategyIds = recent.map((entry) => entry.strategy_id);
  const allSameStrategy = strategyIds[0] !== null && strategyIds.every((strategyId) => strategyId === strategyIds[0]);
  if (allSameStrategy) {
    const similarity01 = stringSimilarity(outputs[0], outputs[1]);
    const similarity12 = stringSimilarity(outputs[1], outputs[2]);
    const averageSimilarity = (similarity01 + similarity12) / 2;
    if (averageSimilarity >= SIMILARITY_THRESHOLD) {
      return {
        isRepetitive: true,
        pattern: "identical_actions",
        confidence: Math.min(averageSimilarity, TEXT_FALLBACK_MAX_CONFIDENCE),
        source: "text_fallback",
      };
    }
  }

  if (taskHistory.length >= 4) {
    const last4 = taskHistory.slice(-4);
    const outputs4 = last4.map((entry) => entry.output);
    const similarity02 = stringSimilarity(outputs4[0], outputs4[2]);
    const similarity13 = stringSimilarity(outputs4[1], outputs4[3]);
    const similarity01 = stringSimilarity(outputs4[0], outputs4[1]);
    if (
      similarity02 >= SIMILARITY_THRESHOLD &&
      similarity13 >= SIMILARITY_THRESHOLD &&
      similarity01 < SIMILARITY_THRESHOLD
    ) {
      return {
        isRepetitive: true,
        pattern: "oscillating",
        confidence: Math.min(Math.min(similarity02, similarity13), TEXT_FALLBACK_MAX_CONFIDENCE),
        source: "text_fallback",
      };
    }
  }

  return { isRepetitive: false, pattern: null, confidence: 0, source: "none" };
}

function hasMaterialTaskChange(entry: StallTaskHistoryEntry): boolean {
  const result = entry.task_result;
  if (!result) return false;

  if ((result.changed_files?.length ?? 0) > 0) return true;
  if ((result.artifact_changes?.length ?? 0) > 0) return true;

  const diffStats = result.diff_stats;
  if (!diffStats) return false;
  return (
    (diffStats.files_changed ?? 0) > 0 ||
    (diffStats.insertions ?? 0) > 0 ||
    (diffStats.deletions ?? 0) > 0
  );
}

function hasTypedNoOpEvidence(entry: StallTaskHistoryEntry): boolean {
  const result = entry.task_result;
  if (!result || hasMaterialTaskChange(entry)) return false;

  const hasZeroChangedFiles = result.changed_files !== undefined && result.changed_files.length === 0;
  const hasZeroArtifactChanges = result.artifact_changes !== undefined && result.artifact_changes.length === 0;
  const hasZeroDiffStats = result.diff_stats !== undefined &&
    (result.diff_stats.files_changed ?? 0) === 0 &&
    (result.diff_stats.insertions ?? 0) === 0 &&
    (result.diff_stats.deletions ?? 0) === 0;

  return hasZeroChangedFiles || hasZeroArtifactChanges || hasZeroDiffStats;
}
