import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSkillsDir } from "../../base/utils/paths.js";
import {
  isPathInside,
  parseSkillFile,
  toSafeSkillId,
  type SkillSource,
} from "./skill-parser.js";
import {
  createAssetRecord,
  toAssetId,
  type AssetRecord,
} from "../assets/types.js";
import {
  classifySkillBundleMutationTarget,
  copySkillBundleNoSymlinks,
  describeSkillBundle,
  inferSkillSourceAgent,
  type SkillBundleManifest,
} from "./skill-bundle.js";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  path: string;
  relativePath: string;
  source: SkillSource;
  bundle: SkillBundleManifest;
}

export interface SkillRegistryOptions {
  homeSkillsDir?: string;
  workspaceRoot?: string;
}

export class SkillRegistry {
  private readonly homeSkillsDir: string;
  private readonly workspaceRoot: string | undefined;

  constructor(options: SkillRegistryOptions = {}) {
    this.homeSkillsDir = options.homeSkillsDir ?? getSkillsDir();
    this.workspaceRoot = options.workspaceRoot;
  }

  async list(): Promise<SkillRecord[]> {
    const home = await this.scanRoot(this.homeSkillsDir, "home");
    const workspaceSkillsDir = this.workspaceRoot
      ? path.join(this.workspaceRoot, "skills")
      : undefined;
    const workspace = workspaceSkillsDir
      ? await this.scanRoot(workspaceSkillsDir, "workspace")
      : [];
    return [...home, ...workspace].sort((a, b) => a.id.localeCompare(b.id));
  }

  async listAssetRecords(now = new Date().toISOString()): Promise<AssetRecord[]> {
    const skills = await this.list();
    return Promise.all(skills.map(async (skill) => {
      const sourceAgent = inferSkillSourceAgent(skill.relativePath);
      return createAssetRecord({
        id: toAssetId("skill_bundle", [skill.id]),
        kind: "skill_bundle",
        label: skill.name,
        source_agent: sourceAgent,
        source_path: skill.path,
        imported_path: skill.path,
        checksum: skill.bundle.bundleChecksum,
        status: "recorded",
        provenance: {
          source_label: skill.source,
          evidence_refs: [
            skill.relativePath,
            ...skill.bundle.files.map((file) => file.relativePath),
          ],
        },
        metadata: {
          description: skill.description,
          registry_source: skill.source,
          relative_path: skill.relativePath,
          bundle_manifest: skill.bundle,
          compatibility: skill.bundle.compatibility,
          protected_target: classifySkillBundleMutationTarget(skill.path, {
            homeSkillsDir: this.homeSkillsDir,
            workspaceRoot: this.workspaceRoot,
          }),
        },
      }, now);
    }));
  }

  async search(query: string): Promise<SkillRecord[]> {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    const skills = await this.list();
    return skills.filter((skill) => [
      skill.id,
      skill.name,
      skill.description,
      skill.relativePath,
    ].some((value) => value.toLowerCase().includes(normalized)));
  }

  async get(idOrName: string): Promise<SkillRecord | null> {
    const normalized = idOrName.trim().toLowerCase();
    const skills = await this.list();
    return skills.find((skill) =>
      skill.id.toLowerCase() === normalized ||
      skill.name.toLowerCase() === normalized
    ) ?? null;
  }

  async read(idOrName: string): Promise<{ skill: SkillRecord; body: string } | null> {
    const skill = await this.get(idOrName);
    if (!skill) return null;
    return { skill, body: await fsp.readFile(skill.path, "utf-8") };
  }

  async install(sourcePath: string, options: { namespace?: string; force?: boolean } = {}): Promise<SkillRecord> {
    const stat = await fsp.stat(sourcePath);
    const skillFile = stat.isDirectory() ? path.join(sourcePath, "SKILL.md") : sourcePath;
    if (!skillFile.endsWith("SKILL.md")) {
      throw new Error("skill install source must be a SKILL.md file or a directory containing SKILL.md");
    }
    const content = await fsp.readFile(skillFile, "utf-8");
    const parsed = parseSkillFile(content, skillFile, "home", path.dirname(skillFile));
    const namespace = toSafeSkillId(options.namespace?.trim() || "imported") || "imported";
    const parsedId = parsed.id === "." ? "" : parsed.id;
    const safeName = toSafeSkillId(parsedId || path.basename(path.dirname(skillFile)) || parsed.name);
    const destDir = path.join(this.homeSkillsDir, namespace, safeName);
    const destFile = path.join(destDir, "SKILL.md");
    if (!isPathInside(this.homeSkillsDir, destFile)) {
      throw new Error("skill install destination must stay inside the skills directory");
    }
    if (fs.existsSync(destFile) && !options.force) {
      throw new Error(`skill "${namespace}/${safeName}" already exists; use --force to overwrite`);
    }
    if (options.force) {
      await fsp.rm(destDir, { recursive: true, force: true });
    }
    await copySkillBundleNoSymlinks(path.dirname(skillFile), destDir);
    return this.skillRecordFromFile(destFile, "home", this.homeSkillsDir, `${namespace}/${safeName}`);
  }

  private async scanRoot(root: string, source: SkillRecord["source"]): Promise<SkillRecord[]> {
    const found: SkillRecord[] = [];
    await walk(root, async (file) => {
      if (path.basename(file) !== "SKILL.md") return;
      try {
        found.push(await this.skillRecordFromFile(file, source, root));
      } catch {
        // Ignore unreadable skill files while keeping the registry usable.
      }
    });
    return found;
  }

  private async skillRecordFromFile(
    file: string,
    source: SkillRecord["source"],
    root: string,
    overrideId?: string
  ): Promise<SkillRecord> {
    const content = await fsp.readFile(file, "utf-8");
    const parsed = parseSkillFile(content, file, source, root);
    const relativePath = path.relative(root, file);
    const sourceAgent = inferSkillSourceAgent(overrideId ?? parsed.relativePath);
    return {
      ...parsed,
      ...(overrideId ? { id: overrideId, relativePath } : {}),
      bundle: await describeSkillBundle(file, { sourceAgent }),
    };
  }
}

async function walk(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}
