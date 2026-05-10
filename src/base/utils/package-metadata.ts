import { z } from "zod";

const PackageStringRecordSchema = z.record(z.string(), z.string());
const PackageManifestShapeSchema = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  scripts: z.unknown().optional(),
  dependencies: z.unknown().optional(),
}).passthrough();

export interface PackageMetadata {
  name: string;
  description: string;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

export function createEmptyPackageMetadata(): PackageMetadata {
  return { name: "", description: "", scripts: {}, dependencies: {} };
}

export function parsePackageMetadata(raw: string): PackageMetadata | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  const manifest = PackageManifestShapeSchema.safeParse(decoded);
  if (!manifest.success) {
    return null;
  }

  const scripts = PackageStringRecordSchema.safeParse(manifest.data.scripts);
  const dependencies = PackageStringRecordSchema.safeParse(manifest.data.dependencies);
  return {
    name: typeof manifest.data.name === "string" ? manifest.data.name : "",
    description: typeof manifest.data.description === "string" ? manifest.data.description : "",
    scripts: scripts.success ? scripts.data : {},
    dependencies: dependencies.success ? dependencies.data : {},
  };
}

export function formatNodePackageMetadataContext(metadata: PackageMetadata): string {
  const scripts = Object.keys(metadata.scripts).join(", ");
  const prefix = metadata.name ? `Node.js project '${metadata.name}'` : "Node.js project";
  const description = metadata.description ? `. ${metadata.description}` : "";
  const scriptsPart = scripts ? `. Scripts: ${scripts}` : "";
  return `${prefix}${description}${scriptsPart}`;
}
