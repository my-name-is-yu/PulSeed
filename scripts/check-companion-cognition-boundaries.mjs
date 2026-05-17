#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const srcRoot = join(root, "src");

const allowed = new Set([
  "src/runtime/cognition/companion-cognition-service.ts",
  "src/runtime/cognition/model-context-policy-projection.ts",
  "src/runtime/cognition/relationship-state-projection.ts",
]);

const checks = [
  {
    pattern: /\bresolveRelationshipSurfaceContext\b/,
    message: "chat relationship surface must come from CompanionCognitionKernel output, not a direct caller helper",
  },
  {
    pattern: /\bnew\s+CompanionCognitionService\s*\(/,
    message: "production callers must instantiate CompanionCognitionKernel; CompanionCognitionService is a compatibility facade",
  },
  {
    pattern: /\bcreateRelationshipStateProjectionV2\s*\(/,
    message: "relationship projection assembly must stay inside the cognition kernel boundary",
  },
  {
    pattern: /\bbuildGatewayModelLoopSystemPrompt\b/,
    message: "gateway behavioral prompt policy must be rendered from typed CompanionCognitionKernel output",
  },
  {
    pattern: /Default gateway tool contract|Do not invent current workspace|Keep PulSeed runtime-control actions/,
    message: "gateway behavioral prompt text must stay inside the cognition model-context projection boundary",
  },
  {
    pattern: /memory[- ]use policy|behavioral prompt policy|action policy shortcut/i,
    message: "direct companion memory/action/prompt policy assembly must stay behind the cognition kernel boundary",
  },
];

const issues = [];
for (const filePath of walk(srcRoot)) {
  const rel = relative(root, filePath);
  if (!rel.endsWith(".ts")) continue;
  if (rel.includes("/__tests__/") || rel.endsWith(".test.ts")) continue;
  if (allowed.has(rel)) continue;
  const text = readFileSync(filePath, "utf8");
  for (const check of checks) {
    if (check.pattern.test(text)) {
      issues.push(`${rel}: ${check.message}`);
    }
  }
}

if (issues.length > 0) {
  console.error("Companion cognition boundary check failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("Companion cognition boundary check passed.");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      yield* walk(path);
    } else if (stat.isFile()) {
      yield path;
    }
  }
}
