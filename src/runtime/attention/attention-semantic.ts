import type {
  AttentionConflict,
  AttentionScope,
  AttentionSignalRef,
  AttentionStructuredRef,
} from "../types/companion-autonomy.js";
import { refKey, stableId } from "./attention-refs.js";
import type { ScopeCompatibilityDecision } from "./attention-scope.js";

export type SemanticFingerprintInput = {
  scope: AttentionScope;
  signalRefs: AttentionSignalRef[];
  structuredRefs: AttentionStructuredRef[];
  redactedSummary?: string | null;
  locale?: string | null;
};

export type SemanticFingerprintResult = {
  providerId: string;
  providerVersion: string;
  fingerprint: string;
  themeHints: string[];
  confidence: number;
  outcome: "known" | "unknown" | "insufficient_context";
  redactionLevel: "none" | "summary_only" | "high_sensitivity_summary";
  cacheKey: string;
  createdAt: string;
};

export interface SemanticFingerprintProvider {
  readonly providerId: string;
  readonly providerVersion: string;
  createFingerprint(input: SemanticFingerprintInput): Promise<SemanticFingerprintResult>;
}

export type AttentionSimilarityInput = {
  ref: { kind: "urge_candidate" | "attention_cluster"; id: string };
  scope: AttentionScope;
  semanticFingerprint?: SemanticFingerprintResult | null;
  structuredRefs: readonly AttentionStructuredRef[];
  signalRefs: readonly AttentionSignalRef[];
};

export type AttentionSimilarityDecision =
  | { outcome: "same_concern"; basis: "semantic" | "structured_ref" | "semantic_and_structured_ref"; confidence: number; reasons: string[] }
  | { outcome: "related_but_distinct"; basis: "semantic" | "structured_ref" | "mixed"; confidence: number; reasons: string[] }
  | { outcome: "conflict"; conflict: AttentionConflict; reasons: string[] }
  | { outcome: "unknown"; reasons: string[] };

const MIN_SEMANTIC_CONFIDENCE = 0.7;

export class DeterministicSemanticFingerprintProvider implements SemanticFingerprintProvider {
  readonly providerId = "deterministic-attention-test-provider";
  readonly providerVersion: string;

  constructor(providerVersion = "v1") {
    this.providerVersion = providerVersion;
  }

  async createFingerprint(input: SemanticFingerprintInput): Promise<SemanticFingerprintResult> {
    const structuredKey = input.structuredRefs.map((structuredRef) =>
      `${structuredRef.relation}:${refKey(structuredRef.ref)}`
    ).sort().join("|");
    const summaryKey = input.redactedSummary?.trim()
      ? `summary:${stableId(input.redactedSummary.trim().toLocaleLowerCase(input.locale ?? "en-US"))}`
      : "";
    const base = structuredKey || summaryKey;
    const outcome = base ? "known" : "insufficient_context";
    const sensitivity = input.scope.sensitivity;

    return {
      providerId: this.providerId,
      providerVersion: this.providerVersion,
      fingerprint: outcome === "known" ? `attention-fingerprint:${stableId(base)}` : "attention-fingerprint:unknown",
      themeHints: structuredKey ? [`structured:${stableId(structuredKey)}`] : [],
      confidence: structuredKey ? 0.9 : summaryKey ? 0.75 : 0,
      outcome,
      redactionLevel: sensitivity === "high"
        ? "high_sensitivity_summary"
        : input.redactedSummary
          ? "summary_only"
          : "none",
      cacheKey: `semantic-cache:${this.providerId}:${this.providerVersion}:${stableId(`${base}:${input.scope.policyEpoch}`)}`,
      createdAt: new Date(0).toISOString(),
    };
  }
}

export function decideAttentionSimilarity(input: {
  left: AttentionSimilarityInput;
  right: AttentionSimilarityInput;
  scopeDecision: ScopeCompatibilityDecision;
}): AttentionSimilarityDecision {
  if (input.scopeDecision.outcome === "conflict") {
    return {
      outcome: "conflict",
      conflict: input.scopeDecision.conflict,
      reasons: input.scopeDecision.reasons,
    };
  }
  if (input.scopeDecision.outcome === "unknown") {
    return {
      outcome: "unknown",
      reasons: input.scopeDecision.reasons,
    };
  }

  const structuredOverlap = exactStructuredRefOverlap(input.left.structuredRefs, input.right.structuredRefs);
  const leftFingerprint = input.left.semanticFingerprint;
  const rightFingerprint = input.right.semanticFingerprint;
  const semanticUsable = isUsableSemanticFingerprint(leftFingerprint)
    && isUsableSemanticFingerprint(rightFingerprint)
    && leftFingerprint.providerId === rightFingerprint.providerId
    && leftFingerprint.providerVersion === rightFingerprint.providerVersion;

  if (semanticUsable && leftFingerprint.fingerprint === rightFingerprint.fingerprint) {
    return {
      outcome: "same_concern",
      basis: structuredOverlap ? "semantic_and_structured_ref" : "semantic",
      confidence: Math.min(leftFingerprint.confidence, rightFingerprint.confidence),
      reasons: structuredOverlap
        ? ["semantic fingerprint and exact structured refs agree"]
        : ["versioned semantic fingerprint matches"],
    };
  }

  if (structuredOverlap && (!leftFingerprint || !rightFingerprint || !semanticUsable)) {
    return {
      outcome: "same_concern",
      basis: "structured_ref",
      confidence: 0.85,
      reasons: ["exact structured refs match through the owner similarity decision"],
    };
  }

  if (structuredOverlap) {
    return {
      outcome: "related_but_distinct",
      basis: "mixed",
      confidence: 0.65,
      reasons: ["structured refs overlap, but semantic fingerprints do not match"],
    };
  }

  if (leftFingerprint && rightFingerprint && leftFingerprint.providerVersion !== rightFingerprint.providerVersion) {
    return {
      outcome: "unknown",
      reasons: ["semantic provider version mismatch requires regrounding before merge"],
    };
  }

  return {
    outcome: "unknown",
    reasons: ["no compatible structured or semantic concern basis"],
  };
}

function isUsableSemanticFingerprint(
  result: SemanticFingerprintResult | null | undefined,
): result is SemanticFingerprintResult {
  return !!result
    && result.outcome === "known"
    && result.confidence >= MIN_SEMANTIC_CONFIDENCE
    && result.cacheKey.length > 0;
}

function exactStructuredRefOverlap(
  left: readonly AttentionStructuredRef[],
  right: readonly AttentionStructuredRef[],
): boolean {
  const rightKeys = new Set(right.map((candidate) => `${candidate.relation}:${refKey(candidate.ref)}`));
  return left.some((candidate) => rightKeys.has(`${candidate.relation}:${refKey(candidate.ref)}`));
}
