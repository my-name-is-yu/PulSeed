import * as fsp from "node:fs/promises";
import type { IndexedFile, TestContext } from "../contracts.js";
import { isTestPath } from "../path-policy.js";

const TEST_NAME_RE = /^\s*(?:describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/gm;
const IMPORT_RE = /^\s*import\s+(?:type\s+)?(?:[^"'`]+from\s+)?["'`]([^"'`]+)["'`]/gm;

export async function buildTestIndex(files: IndexedFile[]): Promise<TestContext> {
  const tests: TestContext["tests"] = [];
  for (const file of files.filter((candidate) => isTestPath(candidate.path))) {
    try {
      const content = await fsp.readFile(file.absolutePath, "utf8");
      tests.push({
        file: file.path,
        names: [...content.matchAll(TEST_NAME_RE)].map((match) => match[1]).slice(0, 80),
        imports: [...content.matchAll(IMPORT_RE)].map((match) => match[1]).slice(0, 80),
      });
    } catch {
      // skip unreadable files
    }
  }
  return { tests };
}
