import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillRegistry } from "../skill-registry.js";

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
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const installed = await registry.install(sourceDir);

    expect(installed.id).toBe("imported/analyze");
    expect(fs.existsSync(path.join(homeSkills, "imported", "analyze", "SKILL.md"))).toBe(true);
  });
});
