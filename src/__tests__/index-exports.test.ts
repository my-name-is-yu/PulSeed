import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const INDEX_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../index.ts");

function loadValueExports(): Map<string, string> {
  const sourceText = fs.readFileSync(INDEX_PATH, "utf-8");
  const exports = new Map<string, string>();
  const exportDeclarationPattern = /export\s*{\s*([^}]+?)\s*}\s*from\s*"([^"]+)";/gs;

  for (const match of sourceText.matchAll(exportDeclarationPattern)) {
    const [, specifierList, moduleSpecifier] = match;
    for (const rawSpecifier of specifierList!.split(",")) {
      const specifier = rawSpecifier.trim();
      if (specifier.length === 0 || specifier.startsWith("type ")) {
        continue;
      }
      const exportedName = specifier.includes(" as ") ? specifier.split(" as ").at(-1)! : specifier;
      exports.set(exportedName.trim(), moduleSpecifier!);
    }
  }

  return exports;
}

describe("src/index.ts exports", () => {
  it("declares core value re-exports from their source modules", () => {
    const exports = loadValueExports();

    expect(exports.get("LLMClient")).toBe("./base/llm/llm-client.js");
    expect(exports.get("MockLLMClient")).toBe("./base/llm/llm-client.js");
    expect(exports.get("extractJSON")).toBe("./base/llm/llm-client.js");
    expect(exports.get("EthicsGate")).toBe("./platform/traits/ethics-gate.js");
    expect(exports.get("StateManager")).toBe("./base/state/state-manager.js");
  });

  it("declares selected utility functions as value exports", () => {
    const exports = loadValueExports();

    expect(exports.get("calculateDimensionGap")).toBe("./platform/drive/gap-calculator.js");
    expect(exports.get("scoreAllDimensions")).toBe("./platform/drive/drive-scorer.js");
    expect(exports.get("buildLLMClient")).toBe("./base/llm/provider-factory.js");
    expect(exports.get("buildGatewayLLMClient")).toBe("./base/llm/provider-factory.js");
  });
});
