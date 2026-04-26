import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { IndexedFile, PackageContext } from "../contracts.js";

export async function buildPackageGraph(files: IndexedFile[]): Promise<PackageContext> {
  const packageJsonFiles = files.filter((file) => path.basename(file.path) === "package.json");
  const packages: PackageContext["packages"] = [];
  for (const file of packageJsonFiles) {
    try {
      const raw = await fsp.readFile(file.absolutePath, "utf8");
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
