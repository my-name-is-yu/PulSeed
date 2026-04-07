export const DREAM_PATTERN_ANALYSIS_SYSTEM_PROMPT = `You analyze Dream Mode runtime traces for PulSeed.
Return valid JSON only.
Find recurring, actionable patterns supported by the evidence windows.
Favor high-signal lessons over exhaustive enumeration.
Use only evidence present in the supplied windows and importance entries.
Analyze recurring tasks, strategy effectiveness, failure and stall precursors, temporal patterns, decision trends, observation reliability, and verification bottlenecks when evidence supports them.
Confidence must be between 0 and 1.
Do not invent evidence refs.`;

export function buildDreamPatternAnalysisPrompt(input: {
  tier: "light" | "deep";
  goalId?: string;
  prioritizedWindows: string;
  regularWindows: string;
  importanceEntries: string;
}): string {
  return `Analyze PulSeed dream-mode iteration windows.
Tier: ${input.tier}
Goal: ${input.goalId ?? "multi-goal"}

Analysis goal:
- Discover recurring patterns that explain progress, stalls, or verification outcomes.
- Prefer patterns that can guide future strategy, task generation, observation, or verification.

Output schema reminder:
- Return a JSON object with a top-level "patterns" array.
- Each pattern must include pattern_type, confidence, summary, metadata, and evidence_refs.
- Use confidence >= 0 and <= 1.
- Keep summaries concise and actionable.

Confidence rubric:
- 0.80-1.00: strong repeated evidence with clear causal signal
- 0.60-0.79: moderate repeated evidence with plausible signal
- below 0.60: weak or speculative and should usually be omitted

Prioritized windows:
${input.prioritizedWindows}

Regular windows:
${input.regularWindows}

Importance entries:
${input.importanceEntries}

Return JSON:
{
  "patterns": [
    {
      "pattern_type": "string",
      "goal_id": "string optional",
      "confidence": 0.0,
      "summary": "string",
      "metadata": {},
      "evidence_refs": ["iter:goal:1"]
    }
  ]
}

Example output:
{
  "patterns": [
    {
      "pattern_type": "recurring_task",
      "goal_id": "${input.goalId ?? "goal-id"}",
      "confidence": 0.82,
      "summary": "Retrying lightweight verification after observation drift often restores progress.",
      "metadata": {
        "taskAction": "rerun_verification",
        "frequency": 6,
        "success_rate": 0.67,
        "avg_gap_reduction": 0.11
      },
      "evidence_refs": ["iter:${input.goalId ?? "goal-id"}:143", "iter:${input.goalId ?? "goal-id"}:144"]
    }
  ]
}`;
}
