import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillRegistry } from "../skill-registry.js";
import { classifySkillBundleMutationTarget } from "../skill-bundle.js";

describe("SkillRegistry", () => {
  let tmpDir: string;
  let homeSkills: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-skills-"));
    homeSkills = path.join(tmpDir, "skills");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("lists and searches SKILL.md files from home and workspace roots", async () => {
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.join(homeSkills, "imported", "review"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "skills", "deploy"), { recursive: true });
    fs.writeFileSync(path.join(homeSkills, "imported", "review", "SKILL.md"), "# Review\nCheck code quality.\n");
    fs.writeFileSync(path.join(workspace, "skills", "deploy", "SKILL.md"), "# Deploy\nShip release safely.\n");

    const registry = new SkillRegistry({ homeSkillsDir: homeSkills, workspaceRoot: workspace });
    const all = await registry.list();
    const search = await registry.search("release");

    expect(all.map((skill) => skill.id)).toEqual(["deploy", "imported/review"]);
    expect(search).toHaveLength(1);
    expect(search[0]!.name).toBe("Deploy");
  });

  it("installs a local skill into imported namespace", async () => {
    const sourceDir = path.join(tmpDir, "source", "analyze");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Analyze\nRead the system.\n");
    fs.mkdirSync(path.join(sourceDir, "scripts"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "examples"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "templates"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "scripts", "run.sh"), "echo ok\n");
    fs.writeFileSync(path.join(sourceDir, "examples", "input.md"), "example\n");
    fs.writeFileSync(path.join(sourceDir, "templates", "note.md"), "{{value}}\n");
    fs.writeFileSync(path.join(sourceDir, "assets", "data.txt"), "asset\n");
    fs.writeFileSync(path.join(sourceDir, "references", "guide.md"), "guide\n");
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const installed = await registry.install(sourceDir);

    expect(installed.id).toBe("imported/analyze");
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "scripts", "run.sh"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "examples", "input.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "templates", "note.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "assets", "data.txt"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "references", "guide.md"))).toBe(true);
    expect(installed.bundle.files.map((file) => file.relativePath).sort()).toEqual([
      "SKILL.md",
      "assets/data.txt",
      "examples/input.md",
      "references/guide.md",
      "scripts/run.sh",
      "templates/note.md",
    ]);
    expect(installed.bundle.directories).toMatchObject({
      scripts: true,
      examples: true,
      templates: true,
      assets: true,
      references: true,
    });
  });

  it("installs a SKILL.md file path as its containing bundle", async () => {
    const sourceDir = path.join(tmpDir, "source", "file-install");
    fs.mkdirSync(path.join(sourceDir, "references"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "SKILL.md"),
      "# File Install\nSee [guide](references/guide.md).\n"
    );
    fs.writeFileSync(path.join(sourceDir, "references", "guide.md"), "guide\n");
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const installed = await registry.install(path.join(sourceDir, "SKILL.md"));

    expect(installed.id).toBe("imported/file-install");
    expect(fs.existsSync(path.join(homeSkills, "imported", "file-install", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "file-install", "references", "guide.md"))).toBe(true);
    expect(installed.bundle.compatibility).toMatchObject({
      referenced_paths: ["references/guide.md"],
      execution_mapping_status: "advisory_only",
    });
  });

  it("sanitizes install namespace before writing inside skills root", async () => {
    const sourceDir = path.join(tmpDir, "source", "audit");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Audit\nReview risky changes.\n");
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const installed = await registry.install(sourceDir, { namespace: "../../pwn" });

    expect(installed.id).toBe("pwn/audit");
    expect(fs.existsSync(path.join(homeSkills, "pwn", "audit", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pwn", "audit", "SKILL.md"))).toBe(false);
  });

  it("uses frontmatter description when present", async () => {
    fs.mkdirSync(path.join(homeSkills, "imported", "frontmatter"), { recursive: true });
    fs.writeFileSync(
      path.join(homeSkills, "imported", "frontmatter", "SKILL.md"),
      "---\nname: Review Skill\ndescription: Finds correctness risks.\n---\n# Review\nBody text.\n"
    );
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const [skill] = await registry.search("correctness");

    expect(skill?.name).toBe("Review");
    expect(skill?.description).toBe("Finds correctness risks.");
  });

  it("keeps unknown tool references advisory and non-executable in bundle metadata", async () => {
    const skillDir = path.join(homeSkills, "imported", "unknown-tool");
    fs.mkdirSync(path.join(skillDir, "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      [
        "---",
        "description: Uses an external helper.",
        "tools:",
        "  - MissingTool",
        "commands:",
        "  - external-helper",
        "---",
        "# Unknown Tool",
        "See [script](scripts/run.sh).",
      ].join("\n")
    );
    fs.writeFileSync(path.join(skillDir, "scripts", "run.sh"), "echo ok\n");
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const [asset] = await registry.listAssetRecords("2026-05-09T14:30:00.000Z");

    expect(asset?.metadata?.["compatibility"]).toMatchObject({
      referenced_tools: ["MissingTool"],
      referenced_commands: ["external-helper"],
      unsupported_references: ["tool:MissingTool", "command:external-helper"],
      advisory_safe: true,
      execution_mapping_status: "blocked_unresolved_references",
    });
    expect(asset?.metadata?.["bundle_manifest"]).toMatchObject({
      directories: {
        scripts: true,
      },
    });
  });

  it("projects discovered skills as non-executable asset records", async () => {
    const skillDir = path.join(homeSkills, "imported", "review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), "# Review\nCheck code quality.\n");
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const [asset] = await registry.listAssetRecords("2026-05-09T14:30:00.000Z");

    expect(asset).toMatchObject({
      id: "skill_bundle:imported/review",
      kind: "skill_bundle",
      label: "Review",
      source_agent: "unknown",
      imported_path: path.join(skillDir, "SKILL.md"),
      status: "recorded",
      metadata: {
        registry_source: "home",
      },
    });
    expect(asset?.checksum).toMatch(/^sha256:/);
    expect(asset?.metadata?.["protected_target"]).toMatchObject({
      protected: true,
      reason: "user_authored_skill",
      defaultAutonomousWrite: "blocked",
      requiredDisposition: "quarantine_or_review_or_approval",
    });
  });

  it("classifies user-authored skill files as protected default-autonomous write targets", () => {
    const skillPath = path.join(homeSkills, "imported", "review", "SKILL.md");
    const outsidePath = path.join(tmpDir, "generated", "review.md");

    expect(classifySkillBundleMutationTarget(skillPath, { homeSkillsDir: homeSkills })).toMatchObject({
      protected: true,
      reason: "user_authored_skill",
      defaultAutonomousWrite: "blocked",
      requiredDisposition: "quarantine_or_review_or_approval",
    });
    expect(classifySkillBundleMutationTarget(outsidePath, { homeSkillsDir: homeSkills })).toMatchObject({
      protected: false,
      defaultAutonomousWrite: "not_applicable",
    });
  });
});
