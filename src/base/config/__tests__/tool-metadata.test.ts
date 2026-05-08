import { describe, expect, it } from "vitest";

import {
  CONFIG_METADATA,
  buildConfigKeyDescription,
  buildConfigToolDescription,
  buildMutationToolDescription,
} from "../tool-metadata.js";

const JAPANESE_SCRIPT = /[\u3040-\u30ff\u3400-\u9fff]/u;

describe("tool metadata descriptions", () => {
  it("keeps generated config metadata in English-facing copy", () => {
    const descriptions = [
      buildConfigToolDescription(),
      ...Object.keys(CONFIG_METADATA).map((key) => buildConfigKeyDescription(key)),
    ];

    for (const description of descriptions) {
      expect(description).not.toMatch(JAPANESE_SCRIPT);
    }
  });

  it("describes daemon mode through the current daemon runtime surface", () => {
    const description = buildConfigKeyDescription("daemon_mode");

    expect(description).toContain("background daemon process");
    expect(description).toContain("goal runtime");
    expect(description).not.toContain("CoreLoop");
  });

  it("keeps mutation tool descriptions in English-facing copy", () => {
    const description = buildMutationToolDescription("delete_goal");

    expect(description).not.toMatch(JAPANESE_SCRIPT);
    expect(description).toContain("explicit user confirmation");
    expect(description).toContain("cannot be undone");
  });
});
