import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { cmdSkills } from "../commands/skills.js";
import { SkillRegistry } from "../../../runtime/skills/skill-registry.js";

describe("cmdSkills", () => {
  let logs: string[];
  let errors: string[];
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-cli-skills-"));
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ""));
    });
    vi.spyOn(console, "error").mockImplementation((message?: unknown) => {
      errors.push(String(message ?? ""));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("lists skills from the registry", async () => {
    const registry = {
      list: vi.fn().mockResolvedValue([
        { id: "review", source: "home", description: "Review code" },
      ]),
    };

    const exitCode = await cmdSkills(["list"], registry as never);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("review");
    expect(registry.list).toHaveBeenCalled();
  });

  it("requires a query for search", async () => {
    const exitCode = await cmdSkills(["search"], {} as never);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("query is required");
  });

  it("shows bundle metadata without rewriting the skill body", async () => {
    const registry = {
      read: vi.fn().mockResolvedValue({
        skill: {
          id: "review",
          source: "home",
          description: "Review code",
          bundle: {
            files: [{ relativePath: "scripts/check.sh" }],
            compatibility: {
              execution_mapping_status: "blocked_unresolved_references",
            },
          },
        },
        body: "# Review\nOriginal body.\n",
      }),
    };

    const metadataExit = await cmdSkills(["show", "review", "--metadata"], registry as never);
    const bodyExit = await cmdSkills(["show", "review"], registry as never);

    expect(metadataExit).toBe(0);
    expect(bodyExit).toBe(0);
    expect(logs[0]).toContain("scripts/check.sh");
    expect(logs[1]).toBe("# Review\nOriginal body.\n");
  });

  it("installs a documented SKILL.md path without dropping sibling bundle files", async () => {
    const sourceDir = path.join(tmpDir, "source", "review");
    const homeSkills = path.join(tmpDir, "home-skills");
    fs.mkdirSync(path.join(sourceDir, "references"), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# Review\nSee [guide](references/guide.md).\n");
    fs.writeFileSync(path.join(sourceDir, "references", "guide.md"), "guide\n");
    const registry = new SkillRegistry({ homeSkillsDir: homeSkills });

    const exitCode = await cmdSkills(["install", path.join(sourceDir, "SKILL.md")], registry);

    expect(exitCode).toBe(0);
    expect(fs.existsSync(path.join(homeSkills, "imported", "review", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(homeSkills, "imported", "review", "references", "guide.md"))).toBe(true);
  });
});
