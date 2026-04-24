import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  getRuntimeIdentitySlotContent,
  getSelfIdentityResponseForBaseDir,
  loadIdentityFromBaseDir,
} from "../../../../../base/config/identity-loader.js";
import { renderSeedMd, writeSeedMd } from "../steps-runtime.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-setup-identity-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("setup runtime identity files", () => {
  it("renders the setup agent name into SEED.md heading and body", () => {
    const rendered = renderSeedMd("Sprout");

    expect(rendered).toContain("# Sprout");
    expect(rendered).toContain("I'm Sprout");
    expect(rendered).not.toContain("# Seedy");
    expect(rendered).not.toContain("I'm Seedy");
  });

  it("uses setup-created SEED.md as the local self-grounding source", () => {
    const dir = makeTempDir();
    writeSeedMd(dir, "Sprout");

    const identity = loadIdentityFromBaseDir(dir);
    const slot = getRuntimeIdentitySlotContent(identity);
    const response = getSelfIdentityResponseForBaseDir(dir);

    expect(identity.name).toBe("Sprout");
    expect(identity.seed).toContain("I'm Sprout");
    expect(slot).toContain("SEED.md is the canonical local setup file");
    expect(slot).toContain("Active agent name: Sprout");
    expect(response).toContain("私はSproutです");
  });
});
