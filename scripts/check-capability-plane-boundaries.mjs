#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = join(root, "src");
const allowedAdapterExecuteCallers = new Set([
  "src/orchestrator/execution/adapter-layer.ts",
  "src/orchestrator/execution/task/task-executor.ts",
  "src/tools/execution/RunAdapterTool/RunAdapterTool.ts",
]);
const issues = [];

for (const filePath of listTypeScriptFiles(sourceRoot)) {
  const rel = relative(root, filePath);
  if (rel.includes("/__tests__/")) continue;
  const source = readFileSync(filePath, "utf8");
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\badapter\s*\.\s*execute\s*\(/.test(line)) continue;
    if (allowedAdapterExecuteCallers.has(rel)) continue;
    issues.push(`${rel}:${index + 1} direct adapter.execute() call must route through Capability Plane admission`);
  }
}

if (issues.length > 0) {
  console.error("Capability Plane boundary check failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("Capability Plane boundary check passed.");

function listTypeScriptFiles(dir) {
  const entries = readdirSync(dir).map((entry) => join(dir, entry));
  const files = [];
  for (const entry of entries) {
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      files.push(...listTypeScriptFiles(entry));
    } else if (entry.endsWith(".ts")) {
      files.push(entry);
    }
  }
  return files;
}
