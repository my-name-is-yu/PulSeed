import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "tests", "docs"];
const LEGACY_PATTERNS = [
  ["Companion", "DecisionFrame"].join(""),
  ["Memory", "Gateway"].join(""),
  ["companion", "cognition", "assembly"].join("-"),
  ["memory", "gateway"].join("-"),
  ["decision", "frame"].join("_"),
  ["companion", "decision", "frame"].join("_"),
  ["decisionFrame", "Ref"].join(""),
  ["Companion", "DecisionInputRef"].join(""),
  ["Companion", "DecisionCallerPathKind"].join(""),
  ["decision", "input", "refs"].join("_"),
];

describe("legacy companion cognition abstraction guard", () => {
  it("keeps retired trace-only and broad memory gateway names out of live source, tests, and docs", () => {
    const findings: string[] = [];
    for (const relativeDir of SCAN_DIRS) {
      for (const filePath of walk(path.join(ROOT, relativeDir))) {
        const text = fs.readFileSync(filePath, "utf8");
        for (const pattern of LEGACY_PATTERNS) {
          if (text.includes(pattern)) {
            findings.push(`${path.relative(ROOT, filePath)} contains ${pattern}`);
          }
        }
      }
    }

    expect(findings).toEqual([]);
  });

  it("keeps the companion cognition service advisory instead of owning stores, loops, tools, or approvals", () => {
    const servicePath = path.join(ROOT, "src/runtime/cognition/companion-cognition-service.ts");
    const serviceText = fs.readFileSync(servicePath, "utf8");
    const forbiddenImports = [
      "../store/",
      "../approval-broker",
      "../../orchestrator/loop/",
      "../../orchestrator/execution/agent-loop/",
      "../../tools/",
    ];

    expect(forbiddenImports.filter((specifier) => serviceText.includes(specifier))).toEqual([]);
  });
});

function walk(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".cache") return [];
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(entryPath);
    if (!entry.isFile()) return [];
    if (!/\.(ts|md|json)$/.test(entry.name)) return [];
    return [entryPath];
  });
}
