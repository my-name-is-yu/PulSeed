import * as path from "node:path";
import type { CodeSearchIndexes } from "../contracts.js";
import { buildCodeSearchIndexes } from "./indexer.js";

const cache = new Map<string, { indexes: CodeSearchIndexes; expiresAt: number }>();

export async function getCodeSearchIndexes(root: string, options: { ttlMs?: number; maxFiles?: number } = {}): Promise<CodeSearchIndexes> {
  const resolved = path.resolve(root);
  const ttlMs = options.ttlMs ?? 1_000;
  const cached = cache.get(resolved);
  if (cached && cached.expiresAt > Date.now()) return cached.indexes;
  const indexes = await buildCodeSearchIndexes(resolved, options.maxFiles);
  cache.set(resolved, { indexes, expiresAt: Date.now() + ttlMs });
  return indexes;
}
