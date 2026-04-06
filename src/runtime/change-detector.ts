// ─── ChangeDetector ───
//
// Detects changes in probe results using three modes:
//   threshold: numeric value exceeds a threshold
//   diff:      JSON representation changed vs last baseline
//   presence:  result is non-null and non-empty

export interface ChangeResult {
  changed: boolean;
  details: string;
}

export function detectChange(
  mode: "threshold" | "diff" | "presence",
  currentResult: unknown,
  baselines: unknown[],
  thresholdValue?: number
): ChangeResult {
  switch (mode) {
    case "threshold": {
      const num = Number(currentResult);
      if (isNaN(num)) {
        return { changed: false, details: "threshold: non-numeric result" };
      }
      if (thresholdValue === undefined) {
        return { changed: false, details: "threshold: no threshold_value configured" };
      }
      const changed = num > thresholdValue;
      return {
        changed,
        details: changed
          ? `threshold exceeded: ${num} > ${thresholdValue}`
          : `threshold ok: ${num} <= ${thresholdValue}`,
      };
    }

    case "diff": {
      if (baselines.length === 0) {
        return { changed: false, details: "diff: no baseline to compare" };
      }
      const lastBaseline = baselines[baselines.length - 1];
      const current = JSON.stringify(currentResult);
      const last = JSON.stringify(lastBaseline);
      const changed = current !== last;
      return {
        changed,
        details: changed ? "diff: result changed from last baseline" : "diff: result unchanged",
      };
    }

    case "presence": {
      const changed =
        currentResult !== null &&
        currentResult !== undefined &&
        currentResult !== "" &&
        !(Array.isArray(currentResult) && currentResult.length === 0);
      return {
        changed,
        details: changed ? "presence: non-empty result detected" : "presence: empty result",
      };
    }
  }
}
