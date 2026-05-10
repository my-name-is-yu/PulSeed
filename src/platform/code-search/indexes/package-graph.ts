import * as path from "node:path";
import { readTextFileWithinLimit } from "../../../base/utils/json-io.js";
import type { IndexedFile, PackageContext } from "../contracts.js";

const PACKAGE_JSON_MAX_BYTES = 1024 * 1024;

export async function buildPackageGraph(files: IndexedFile[]): Promise<PackageContext> {
  const packageJsonFiles = files.filter((file) => path.basename(file.path) === "package.json");
  const packages: PackageContext["packages"] = [];
  for (const file of packageJsonFiles) {
    try {
      const raw = await readTextFileWithinLimit(file.absolutePath, {
        maxBytes: PACKAGE_JSON_MAX_BYTES,
      });
      const parsed = JSON.parse(raw) as { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const dependencies = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ].sort();
      packages.push({
        name: parsed.name ?? path.basename(path.dirname(file.path)),
        root: path.dirname(file.path) === "." ? "" : path.dirname(file.path),
        dependencies,
      });
    } catch {
      // ignore malformed package files for search purposes
    }
  }
  return { packages };
}
