import type { CodeSearchIndexes } from "../contracts.js";

export function directImportNeighbors(file: string, indexes: CodeSearchIndexes): string[] {
  const direct = indexes.repoMap.files.find((entry) => entry.file === file);
  if (!direct) return [];
  const localImports = direct.imports
    .filter((specifier) => specifier.startsWith("."))
    .map((specifier) => specifier.replace(/^\.\//, ""));
  const importedBy = indexes.repoMap.files
    .filter((entry) => entry.imports.some((specifier) => file.includes(specifier.replace(/^\.\//, "").replace(/\.(js|ts|tsx|jsx)$/, ""))))
    .map((entry) => entry.file);
  return [...new Set([...localImports, ...importedBy])].slice(0, 20);
}
