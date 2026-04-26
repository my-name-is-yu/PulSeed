import type { CodeSearchIndexes } from "../contracts.js";
import { buildConfigIndex } from "./config-index.js";
import { buildFileIndex } from "./file-index.js";
import { buildPackageGraph } from "./package-graph.js";
import { buildRepoMapIndex } from "./repo-map-index.js";
import { buildSymbolIndex } from "./symbol-index.js";
import { buildTestIndex } from "./test-index.js";

export async function buildCodeSearchIndexes(root: string, maxFiles?: number): Promise<CodeSearchIndexes> {
  const files = await buildFileIndex(root, maxFiles);
  const [symbols, repoMap, tests, configs, packages] = await Promise.all([
    buildSymbolIndex(files),
    buildRepoMapIndex(files),
    buildTestIndex(files),
    Promise.resolve(buildConfigIndex(files)),
    buildPackageGraph(files),
  ]);
  return {
    version: "code-search-v1",
    indexedAt: Date.now(),
    files,
    symbols,
    repoMap,
    tests,
    configs,
    packages,
  };
}
