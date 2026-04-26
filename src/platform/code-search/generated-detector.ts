import * as path from "node:path";

export interface GeneratedClassification {
  generated: boolean;
  vendor: boolean;
  buildArtifact: boolean;
  editable: boolean;
  reasons: string[];
}

const VENDOR_PARTS = new Set(["node_modules", "vendor"]);
const BUILD_PARTS = new Set(["dist", "build", "out", "target", ".next", "coverage", ".turbo"]);
const GENERATED_PARTS = new Set(["generated", "__generated__", ".generated"]);
const BUILD_PREFIXES = ["dist-", "build-", "out-", "target-", "coverage-", ".dist-delete"];

const GENERATED_PATTERNS = [
  /\.pb\.go$/,
  /\.generated\./,
  /\.gen\./,
  /generated/i,
];

export function classifyGeneratedPath(filePath: string): GeneratedClassification {
  const normalized = filePath.split(path.sep).join("/");
  const parts = normalized.split("/");
  const reasons: string[] = [];
  const vendor = parts.some((part) => VENDOR_PARTS.has(part));
  const buildArtifact = parts.some((part) =>
    BUILD_PARTS.has(part) || BUILD_PREFIXES.some((prefix) => part.startsWith(prefix))
  );
  const generated = parts.some((part) => GENERATED_PARTS.has(part)) || GENERATED_PATTERNS.some((pattern) => pattern.test(normalized));

  if (vendor) reasons.push("vendor path");
  if (buildArtifact) reasons.push("build artifact path");
  if (generated) reasons.push("generated path or filename pattern");

  return {
    generated,
    vendor,
    buildArtifact,
    editable: !generated && !vendor && !buildArtifact,
    reasons,
  };
}

export function generatedPenaltyFor(filePath: string): { generated: number; vendor: number; buildArtifact: number; reasons: string[] } {
  const classification = classifyGeneratedPath(filePath);
  return {
    generated: classification.generated ? 4 : 0,
    vendor: classification.vendor ? 6 : 0,
    buildArtifact: classification.buildArtifact ? 5 : 0,
    reasons: classification.reasons,
  };
}
