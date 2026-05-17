#!/usr/bin/env node
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import ts from "typescript";

const root = process.cwd();
const sourceRoot = join(root, "src");
const allowedAdapterExecuteCallers = new Set([
  "src/orchestrator/execution/adapter-layer.ts",
  "src/orchestrator/execution/task/task-executor.ts",
  "src/tools/execution/RunAdapterTool/RunAdapterTool.ts",
]);
const issues = [];
const configPath = ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.typecheck.json")
  ?? ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");

if (!configPath) {
  console.error("Capability Plane boundary check failed: tsconfig not found");
  process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
  console.error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  process.exit(1);
}

const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(configPath));
if (parsedConfig.errors.length > 0) {
  for (const diagnostic of parsedConfig.errors) {
    console.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }
  process.exit(1);
}

const program = ts.createProgram(
  parsedConfig.fileNames.filter((fileName) => isUnder(sourceRoot, fileName)),
  parsedConfig.options,
);
const checker = program.getTypeChecker();
const adapterType = findAdapterType();

for (const sourceFile of program.getSourceFiles()) {
  if (sourceFile.isDeclarationFile) continue;
  if (!isUnder(sourceRoot, sourceFile.fileName)) continue;
  const rel = normalizePath(relative(root, sourceFile.fileName));
  if (rel.includes("/__tests__/")) continue;
  visit(sourceFile, rel);
}

if (issues.length > 0) {
  console.error("Capability Plane boundary check failed:");
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

console.log("Capability Plane boundary check passed.");

function visit(node, rel) {
  if (
    ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === "execute"
    && receiverIsAdapter(node.expression.expression)
  ) {
    if (!allowedAdapterExecuteCallers.has(rel)) {
      const position = node.getSourceFile().getLineAndCharacterOfPosition(node.expression.name.getStart());
      issues.push(`${rel}:${position.line + 1} direct IAdapter.execute() call must route through Capability Plane admission`);
    }
  }
  ts.forEachChild(node, (child) => visit(child, rel));
}

function receiverIsAdapter(expression) {
  const type = checker.getTypeAtLocation(expression);
  return typeAssignableToAdapter(type);
}

function typeAssignableToAdapter(type) {
  if (!type || type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
  if (type.isUnion()) return type.types.some(typeAssignableToAdapter);
  return checker.isTypeAssignableTo(checker.getApparentType(type), adapterType);
}

function findAdapterType() {
  const adapterLayerPath = resolve(root, "src/orchestrator/execution/adapter-layer.ts");
  const sourceFile = program.getSourceFile(adapterLayerPath);
  if (!sourceFile) {
    console.error("Capability Plane boundary check failed: adapter-layer.ts not found in TypeScript program");
    process.exit(1);
  }
  let adapterSymbol = null;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "IAdapter") {
      adapterSymbol = checker.getSymbolAtLocation(node.name);
    }
  });
  if (!adapterSymbol) {
    console.error("Capability Plane boundary check failed: IAdapter type not found");
    process.exit(1);
  }
  return checker.getDeclaredTypeOfSymbol(adapterSymbol);
}

function isUnder(parent, candidate) {
  const rel = relative(parent, candidate);
  return rel !== "" && !rel.startsWith("..") && !resolve(candidate).startsWith("..");
}

function normalizePath(filePath) {
  return filePath.split(/[\\/]/g).join("/");
}
