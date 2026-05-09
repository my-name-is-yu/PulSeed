import * as path from "node:path";
import { fileURLToPath } from "node:url";

function parseSourceUrl(sourcePath: string): URL | null {
  try {
    return new URL(sourcePath);
  } catch {
    return null;
  }
}

export function resolveLocalSoilSourcePath(pagePath: string, sourcePath: string): string | null {
  const normalized = sourcePath.trim();
  if (!normalized) {
    return null;
  }

  const sourceUrl = parseSourceUrl(normalized);
  if (sourceUrl !== null) {
    return sourceUrl.protocol === "file:" ? fileURLToPath(sourceUrl) : null;
  }

  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(path.dirname(pagePath), normalized);
}
