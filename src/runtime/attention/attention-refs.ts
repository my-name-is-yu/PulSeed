import type {
  CompanionAutonomyContentLifecycle,
  CompanionAutonomyRef,
  CompanionAutonomyRefKind,
  CompanionAutonomySourceRef,
} from "../types/companion-autonomy.js";

export function ref(kind: CompanionAutonomyRefKind, id: string, version?: string): CompanionAutonomyRef {
  return version ? { kind, id, version } : { kind, id };
}

export function sourceRef(
  kind: CompanionAutonomyRefKind,
  id: string,
  lifecycle: CompanionAutonomyContentLifecycle = "active"
): CompanionAutonomySourceRef {
  return { ref: ref(kind, id), lifecycle };
}

export function refsOfKind(
  refs: CompanionAutonomyRef[],
  ...kinds: CompanionAutonomyRefKind[]
): CompanionAutonomyRef[] {
  return uniqueRefs(refs.filter((candidate) => kinds.includes(candidate.kind)));
}

export function missingRequiredRefs(
  requiredRefs: readonly CompanionAutonomyRef[],
  admittedRefs: readonly CompanionAutonomyRef[]
): CompanionAutonomyRef[] {
  const admitted = new Set(admittedRefs.map(refKey));
  return requiredRefs.filter((required) => !admitted.has(refKey(required)));
}

export function uniqueRefs(refs: readonly CompanionAutonomyRef[]): CompanionAutonomyRef[] {
  return uniqueBy(refs, refKey);
}

export function uniqueSourceRefs(refs: readonly CompanionAutonomySourceRef[]): CompanionAutonomySourceRef[] {
  return uniqueBy(refs, sourceRefKey);
}

export function uniqueBy<T>(values: readonly T[], keyForValue: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyForValue(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function refKey(value: CompanionAutonomyRef): string {
  return `${value.kind}:${value.id}:${value.version ?? ""}`;
}

export function sourceRefKey(value: CompanionAutonomySourceRef): string {
  return `${refKey(value.ref)}:${value.lifecycle}`;
}

export function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
