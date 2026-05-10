import { describe, expect, it } from "vitest";
import {
  formatNodePackageMetadataContext,
  parsePackageMetadata,
} from "../package-metadata.js";

describe("package metadata utilities", () => {
  it("parses valid package metadata fields", () => {
    const parsed = parsePackageMetadata(JSON.stringify({
      name: "demo",
      description: "A demo package",
      scripts: { test: "vitest run" },
      dependencies: { zod: "^4.0.0" },
    }));

    expect(parsed).toEqual({
      name: "demo",
      description: "A demo package",
      scripts: { test: "vitest run" },
      dependencies: { zod: "^4.0.0" },
    });
  });

  it("returns null for invalid JSON and non-object manifests", () => {
    expect(parsePackageMetadata("not json")).toBeNull();
    expect(parsePackageMetadata(JSON.stringify(["not", "a", "manifest"]))).toBeNull();
  });

  it("drops invalid field shapes without discarding valid fields", () => {
    const parsed = parsePackageMetadata(JSON.stringify({
      name: ["bad"],
      description: { text: "bad" },
      scripts: ["test"],
      dependencies: { zod: "^4.0.0" },
    }));

    expect(parsed).toEqual({
      name: "",
      description: "",
      scripts: {},
      dependencies: { zod: "^4.0.0" },
    });
  });

  it("formats model-facing package context from sanitized fields", () => {
    const parsed = parsePackageMetadata(JSON.stringify({
      name: "demo",
      description: "A demo package",
      scripts: { test: "vitest run", build: "tsc" },
    }));

    if (!parsed) {
      throw new Error("expected valid package metadata");
    }
    expect(formatNodePackageMetadataContext(parsed)).toBe(
      "Node.js project 'demo'. A demo package. Scripts: test, build",
    );
  });
});
