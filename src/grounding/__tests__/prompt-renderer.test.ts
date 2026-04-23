import { describe, expect, it } from "vitest";
import type { GroundingSection } from "../contracts.js";
import { pickGroundingSections, renderPromptSections } from "../renderers/prompt-renderer.js";

const SECTIONS: GroundingSection[] = [
  {
    key: "identity",
    title: "Identity",
    priority: 10,
    estimatedTokens: 10,
    content: "You are Seedy.",
    sources: [],
  },
  {
    key: "execution_policy",
    title: "Execution Policy",
    priority: 20,
    estimatedTokens: 10,
    content: "## Execution Bias\n- Do the next safe thing.",
    sources: [],
  },
  {
    key: "approval_policy",
    title: "Safety And Approval",
    priority: 30,
    estimatedTokens: 10,
    content: "- Ask before destructive changes.",
    sources: [],
  },
];

describe("prompt-renderer", () => {
  it("picks only the requested section keys", () => {
    const picked = pickGroundingSections(SECTIONS, ["identity", "approval_policy"]);

    expect(picked.map((section) => section.key)).toEqual(["identity", "approval_policy"]);
  });

  it("can omit headings for embedded multi-section content while preserving order", () => {
    const rendered = renderPromptSections(SECTIONS, {
      omitHeadingKeys: ["execution_policy"],
      preserveOrder: true,
    });

    expect(rendered).toContain("## Identity");
    expect(rendered).toContain("## Execution Bias");
    expect(rendered).not.toContain("## Execution Policy");
    expect(rendered).toContain("## Safety And Approval");
  });
});
