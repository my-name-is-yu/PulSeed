import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonFile } from "../providers/helpers.js";

let tmpRoots: string[] = [];

async function makeTempFile(name: string, content: string): Promise<string> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-grounding-provider-helpers-"));
  tmpRoots.push(tmpRoot);
  const filePath = path.join(tmpRoot, name);
  await fsp.writeFile(filePath, content, "utf-8");
  return filePath;
}

afterEach(async () => {
  const roots = tmpRoots;
  tmpRoots = [];
  await Promise.all(roots.map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("grounding provider JSON helpers", () => {
  it("returns object records from JSON files", async () => {
    const filePath = await makeTempFile("provider.json", JSON.stringify({ llm: "openai", default_adapter: "codex" }));

    await expect(readJsonFile(filePath)).resolves.toEqual({ llm: "openai", default_adapter: "codex" });
  });

  it("rejects malformed JSON", async () => {
    const filePath = await makeTempFile("provider.json", "{");

    await expect(readJsonFile(filePath)).resolves.toBeNull();
  });

  it.each([
    ["null", "null"],
    ["array", JSON.stringify(["openai"])],
    ["number", "1"],
    ["string", JSON.stringify("openai")],
  ])("rejects parsed %s JSON values that are not records", async (_label, content) => {
    const filePath = await makeTempFile("provider.json", content);

    await expect(readJsonFile(filePath)).resolves.toBeNull();
  });
});
