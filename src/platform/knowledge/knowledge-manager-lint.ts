import { z } from "zod/v3";
import type { KnowledgeManager } from "./knowledge-manager.js";
import {
  LintFindingSchema,
  LintResponseSchema,
  type LintResult,
  type AgentMemoryEntry,
} from "./types/agent-memory.js";

const LINT_SYSTEM_PROMPT = `You are a memory quality auditor. Analyze the provided compiled memory entries and identify:
1. CONTRADICTIONS: entries that conflict with each other (e.g., different values for the same preference/fact)
2. STALENESS: entries that appear outdated based on timestamps or content suggesting superseded information
3. REDUNDANCY: entries with significantly overlapping content that should be merged
4. QUARANTINE: entries whose provided provenance or verification metadata marks them unsafe for planning

Return a JSON object with a "findings" array. Each finding has:
- type: "contradiction" | "staleness" | "redundancy" | "quarantine"
- entry_ids: array of entry IDs involved
- description: brief explanation of the issue
- confidence: 0-1 confidence score
- suggested_action: "flag_review" | "auto_resolve_newest" | "mark_stale" | "merge" | "quarantine"

If no issues found, return {"findings": []}.
Return ONLY valid JSON, no markdown fences.`;

function buildUserPrompt(entries: AgentMemoryEntry[]): string {
  const formatted = entries.map((e) => ({
    id: e.id,
    key: e.key,
    value: e.value,
    summary: e.summary,
    tags: e.tags,
    category: e.category,
    memory_type: e.memory_type,
    verification_status: e.verification_status,
    provenance: e.provenance,
    quarantine_state: e.quarantine_state,
    updated_at: e.updated_at,
  }));
  return `Analyze these ${entries.length} compiled memory entries for contradictions, staleness, and redundancy:\n\n${JSON.stringify(formatted, null, 2)}`;
}

function actionMatchesAutoRepair(finding: z.infer<typeof LintFindingSchema>): boolean {
  switch (finding.type) {
    case "contradiction":
      return finding.suggested_action === "auto_resolve_newest";
    case "staleness":
      return finding.suggested_action === "mark_stale";
    case "redundancy":
      return finding.suggested_action === "merge";
    case "quarantine":
      return finding.suggested_action === "quarantine";
  }
}

const quarantineRiskSignals = new Set([
  "hallucinated",
  "low_provenance",
  "contradiction",
  "prompt_injection_like",
  "unverified_external",
] as const);

function quarantineFindingForEntry(entry: AgentMemoryEntry): z.infer<typeof LintFindingSchema> | null {
  const provenance = entry.provenance;
  const signals = new Set(provenance?.risk_signals ?? []);
  const riskSignal = [...signals].find((signal) => quarantineRiskSignals.has(signal));
  if (riskSignal) {
    return {
      type: "quarantine",
      entry_ids: [entry.id],
      description: `Memory provenance carries risk signal: ${riskSignal}`,
      confidence: 0.9,
      suggested_action: "quarantine",
    };
  }

  const verificationStatus = entry.verification_status ?? provenance?.verification_status;
  if (verificationStatus === "suspicious" || verificationStatus === "contradicted") {
    return {
      type: "quarantine",
      entry_ids: [entry.id],
      description: `Memory verification status is ${verificationStatus}`,
      confidence: 0.85,
      suggested_action: "quarantine",
    };
  }

  if (verificationStatus === "unverified" && provenance && provenance.raw_refs.length === 0) {
    return {
      type: "quarantine",
      entry_ids: [entry.id],
      description: "Memory is explicitly unverified and has no raw provenance refs",
      confidence: 0.8,
      suggested_action: "quarantine",
    };
  }

  if (
    provenance
    && (provenance.source_type === "web" || provenance.source_type === "external")
    && provenance.reliability !== undefined
    && provenance.reliability < 0.5
  ) {
    return {
      type: "quarantine",
      entry_ids: [entry.id],
      description: "Memory comes from a low-reliability external source",
      confidence: 0.75,
      suggested_action: "quarantine",
    };
  }

  return null;
}

function detectQuarantineCandidates(entries: AgentMemoryEntry[]): z.infer<typeof LintFindingSchema>[] {
  return entries
    .map((entry) => quarantineFindingForEntry(entry))
    .filter((finding): finding is z.infer<typeof LintFindingSchema> => Boolean(finding));
}

export async function lintAgentMemory(opts: {
  km: KnowledgeManager;
  llmCall: (prompt: string) => Promise<string>;
  autoRepair?: boolean;
  minAutoRepairConfidence?: number;
  categories?: string[];
}): Promise<LintResult> {
  const { km, llmCall, autoRepair = false, minAutoRepairConfidence = 0, categories } = opts;

  // 1. Load compiled entries (listAgentMemory has no status filter — filter manually)
  const allEntries = await km.listAgentMemory({ limit: 10000, include_archived: false });
  let entries = allEntries.filter((e) => e.status === "compiled" && (e.correction_state?.active ?? true));

  if (categories && categories.length > 0) {
    entries = entries.filter((e) => e.category && categories.includes(e.category));
  }

  const quarantineFindings = detectQuarantineCandidates(entries);
  if (entries.length < 2) {
    let repairsApplied = 0;
    if (autoRepair) {
      for (const finding of quarantineFindings) {
        if (finding.confidence >= minAutoRepairConfidence) {
          repairsApplied += await km.quarantineAgentMemory({
            targetIds: finding.entry_ids,
            reason: finding.description,
            source: "memory_lint",
            confidence: finding.confidence,
            inspectionRefs: finding.entry_ids.map((id) => `agent_memory:${id}`),
          });
        }
      }
    }
    return {
      findings: quarantineFindings,
      repairs_applied: repairsApplied,
      entries_flagged: new Set(quarantineFindings.flatMap((finding) => finding.entry_ids)).size,
    };
  }

  // NOTE: Chunking processes entries independently per window. Contradictions/redundancies
  // across chunk boundaries will not be detected. For most use cases compiled entries
  // are well under 30, so this limit rarely applies.
  // 2. Chunk if needed (max 30 per call)
  const CHUNK_SIZE = 30;
  const allFindings: z.infer<typeof LintFindingSchema>[] = [...quarantineFindings];

  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    const chunk = entries.slice(i, i + CHUNK_SIZE);
    const userPrompt = buildUserPrompt(chunk);
    const raw = await llmCall(LINT_SYSTEM_PROMPT + "\n\n" + userPrompt);

    // Sanitize: strip markdown fences
    const cleaned = raw
      .replace(/```(?:json)?\s*/g, "")
      .replace(/```\s*/g, "")
      .trim();

    try {
      const parsed = LintResponseSchema.parse(JSON.parse(cleaned));
      allFindings.push(...parsed.findings);
    } catch (err) {
      // Log but don't fail — partial results are acceptable
      console.warn("Failed to parse lint LLM response:", err);
    }
  }

  // 3. Apply repairs if autoRepair is enabled
  let repairsApplied = 0;
  const flaggedIds = new Set<string>();
  const entriesById = new Map(entries.map((entry) => [entry.id, entry] as const));

  for (const finding of allFindings) {
    if (!autoRepair || finding.confidence < minAutoRepairConfidence || !actionMatchesAutoRepair(finding)) {
      for (const id of finding.entry_ids) {
        flaggedIds.add(id);
      }
      continue;
    }

    switch (finding.type) {
      case "contradiction": {
        // Keep the most recently updated entry, archive others
        const involved = Array.from(
          new Set(finding.entry_ids),
          (id) => entriesById.get(id)
        ).filter((entry): entry is AgentMemoryEntry => Boolean(entry));
        if (involved.length < 2) break;
        involved.sort(
          (a, b) =>
            new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
        const toArchive = involved.slice(1);
        const archiveIds = toArchive.map((e) => e.id);
        const archived = await km.archiveAgentMemory(archiveIds);
        repairsApplied += archived;
        break;
      }
      case "staleness": {
        // Mark stale entries as corrected and re-save an auditable raw
        // replacement so the fact re-enters verification without physical delete.
        for (const id of finding.entry_ids) {
          const entry = entriesById.get(id);
          if (entry) {
            await km.correctAgentMemory({
              targetId: entry.id,
              correctionKind: "corrected",
              reason: finding.description,
              replacementValue: entry.value,
              replacementKey: entry.key,
              replacementTags: [...new Set([...entry.tags, "needs-reverification"])],
              replacementStatus: "raw",
              actor: "dream_lint",
              provenanceRef: "memory_lint:auto_repair:staleness",
            });
            repairsApplied++;
          }
        }
        break;
      }
      case "redundancy": {
        // Keep the first (richest by value length), archive others
        const involved = Array.from(
          new Set(finding.entry_ids),
          (id) => entriesById.get(id)
        ).filter((entry): entry is AgentMemoryEntry => Boolean(entry));
        if (involved.length < 2) break;
        involved.sort((a, b) => b.value.length - a.value.length);
        const toArchive = involved.slice(1);
        const archiveIds = toArchive.map((e) => e.id);
        const archived = await km.archiveAgentMemory(archiveIds);
        repairsApplied += archived;
        break;
      }
      case "quarantine": {
        const quarantined = await km.quarantineAgentMemory({
          targetIds: finding.entry_ids,
          reason: finding.description,
          source: "memory_lint",
          confidence: finding.confidence,
          inspectionRefs: finding.entry_ids.map((id) => `agent_memory:${id}`),
        });
        repairsApplied += quarantined;
        break;
      }
    }
  }

  return {
    findings: allFindings,
    repairs_applied: repairsApplied,
    entries_flagged: flaggedIds.size,
  };
}
