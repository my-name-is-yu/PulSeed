import type {
  LongRunningArtifactRef,
  LongRunningEvidence,
  LongRunningResult,
} from "./long-running-runtime-schemas.js";

export function renderSummaryMarkdown(result: LongRunningResult): string {
  const lines = [
    "# Long-Running Run Summary",
    "",
    "## Objective",
    result.objective,
    "",
    "## Status",
    result.status,
    "",
    "## Evidence",
    ...renderEvidence(result.evidence),
    "",
    "## Artifacts",
    ...renderArtifacts(result.artifacts),
    "",
    "## Failures",
    ...(result.failures.length > 0 ? result.failures.map((failure) => `- ${failure}`) : ["- none"]),
    "",
    "## Next Action",
    `- Type: ${result.next_action.type}`,
    `- Summary: ${result.next_action.summary}`,
  ];
  if (result.next_action.reason) lines.push(`- Reason: ${result.next_action.reason}`);
  if (result.next_action.command) lines.push(`- Command: ${result.next_action.command}`);
  if (result.next_action.due_at) lines.push(`- Due at: ${result.next_action.due_at}`);
  if (result.next_action.owner) lines.push(`- Owner: ${result.next_action.owner}`);
  lines.push("");
  return `${lines.join("\n")}`;
}

export function renderEvidence(evidence: LongRunningEvidence[]): string[] {
  if (evidence.length === 0) return ["- none"];
  return evidence.map((item) => {
    const value = item.value === undefined ? "" : `: ${String(item.value)}`;
    const summary = item.summary ? ` (${item.summary})` : "";
    const evidencePath = item.path ? ` [${item.path}]` : "";
    return `- ${item.kind} ${item.label}${value}${summary}${evidencePath}`;
  });
}

export function renderArtifacts(artifacts: LongRunningArtifactRef[]): string[] {
  if (artifacts.length === 0) return ["- none"];
  return artifacts.map((artifact) => {
    const target = artifact.state_relative_path ?? artifact.path ?? artifact.url ?? "";
    return `- ${artifact.label}: ${target}`;
  });
}
