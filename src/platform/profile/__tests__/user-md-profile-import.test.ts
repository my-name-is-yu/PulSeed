import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ZodSchema } from "zod/v3";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import {
  createRelationshipProfileProposalsFromUserMdImport,
  extractRelationshipProfileCandidatesFromUserMd,
  parseRelationshipProfileCandidatesFromUserMd,
} from "../user-md-profile-import.js";
import {
  applyRelationshipProfileChangeProposal,
  approveRelationshipProfileChangeProposal,
  loadRelationshipProfileProposalStore,
} from "../profile-change-proposal.js";
import {
  formatRelationshipProfilePromptBlock,
  loadRelationshipProfile,
  seedRelationshipProfileFromSetup,
  upsertRelationshipProfileItem,
} from "../relationship-profile.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-user-md-profile-import-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function structuredUserMd(): string {
  return `# About You

Freeform note: Prefer verbose status reports.

\`\`\`json
{
  "relationship_profile_proposals": [
    {
      "stable_key": "user.preference.status",
      "kind": "preference",
      "value": "Prefer concise status reports.",
      "confidence": 0.91,
      "sensitivity": "private",
      "allowed_scopes": ["local_planning", "memory_retrieval", "user_facing_review"],
      "consent_scopes": ["user_facing_review"],
      "evidence_refs": ["setup:USER.md#status"],
      "rationale": "Explicit structured USER.md import candidate."
    },
    {
      "stable_key": "user.boundary.health",
      "kind": "boundary",
      "value": "Do not use health context outside explicit review.",
      "confidence": 0.66,
      "sensitivity": "sensitive",
      "allowed_scopes": ["user_facing_review"],
      "consent_scopes": ["user_facing_review"],
      "rationale": "Sensitive structured USER.md import candidate."
    }
  ]
}
\`\`\`
`;
}

function makeMockLLMClient(response: string): ILLMClient & {
  messages: LLMMessage[][];
  options: Array<LLMRequestOptions | undefined>;
} {
  const messages: LLMMessage[][] = [];
  const options: Array<LLMRequestOptions | undefined> = [];
  return {
    messages,
    options,
    async sendMessage(inputMessages, inputOptions): Promise<LLMResponse> {
      messages.push(inputMessages);
      options.push(inputOptions);
      return {
        content: response,
        usage: { input_tokens: 10, output_tokens: response.length },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

describe("USER.md relationship profile proposal import", () => {
  it("parses structured USER.md candidates without classifying freeform text", () => {
    const parsed = parseRelationshipProfileCandidatesFromUserMd(structuredUserMd());

    expect(parsed.skipped_blocks).toEqual([]);
    expect(parsed.candidates.map((candidate) => candidate.stable_key)).toEqual([
      "user.preference.status",
      "user.boundary.health",
    ]);
    expect(parsed.candidates[0]?.value).toBe("Prefer concise status reports.");
    expect(parsed.candidates.some((candidate) => candidate.value === "Prefer verbose status reports.")).toBe(false);
  });

  it("turns unstructured USER.md into a review-only life-context proposal without semantic classification", () => {
    const parsed = parseRelationshipProfileCandidatesFromUserMd("# About You\n\nPrefer concise status reports.\n");

    expect(parsed.candidates).toHaveLength(0);
  });

  it("extracts structured candidates from ordinary imported USER.md content through the classifier contract", async () => {
    const llmClient = makeMockLLMClient(JSON.stringify({
      candidates: [
        {
          operation: "upsert_item",
          stable_key: "user.preference.status_reports",
          kind: "preference",
          value: "Prefer concise status reports.",
          confidence: 0.88,
          sensitivity: "private",
          allowed_scopes: ["local_planning", "memory_retrieval", "user_facing_review"],
          consent_scopes: ["user_facing_review"],
          evidence_refs: ["setup:USER.md#preference-status-reports"],
          rationale: "The USER.md content directly states the status report preference.",
        },
      ],
    }));

    const result = await extractRelationshipProfileCandidatesFromUserMd({
      markdown: "# About You\n\nPrefer concise status reports.\n",
      llmClient,
    });

    expect(result.extraction_source).toBe("classifier");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      stable_key: "user.preference.status_reports",
      kind: "preference",
      value: "Prefer concise status reports.",
      allowed_scopes: ["local_planning", "memory_retrieval", "user_facing_review"],
      consent_scopes: ["user_facing_review"],
    });
    expect(llmClient.messages[0]?.[0]?.content).toContain("Prefer concise status reports.");
    expect(llmClient.options[0]).toMatchObject({ model_tier: "light", temperature: 0 });
  });

  it("falls back to a review-only life-context proposal when ordinary USER.md extraction is unavailable", async () => {
    const baseDir = makeTempDir();
    const result = await createRelationshipProfileProposalsFromUserMdImport({
      baseDir,
      importedUserContent: "# About You\n\nPrefer concise status reports.\n",
      now: "2026-05-03T00:00:00.000Z",
    });

    expect(result.proposals).toHaveLength(1);
    expect(result.extraction_source).toBe("review_only_fallback");
    expect(result.proposals[0]).toMatchObject({
      approval_state: "pending",
      source: "setup_import",
      proposed_item: {
        stable_key: "user.imported_user_md.review",
        kind: "life_context",
        allowed_scopes: ["user_facing_review"],
      },
    });
  });

  it("creates approval-required proposals while keeping raw USER.md review-only", async () => {
    const baseDir = makeTempDir();
    const importedUserContent = structuredUserMd();

    await seedRelationshipProfileFromSetup({
      baseDir,
      userName: "Imported USER.md",
      importedUserContent,
      now: "2026-05-03T00:00:00.000Z",
    });
    const result = await createRelationshipProfileProposalsFromUserMdImport({
      baseDir,
      importedUserContent,
      now: "2026-05-03T00:01:00.000Z",
    });

    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.map((proposal) => proposal.approval_state)).toEqual(["pending", "pending"]);
    expect(result.proposals[1]?.sensitivity).toBe("sensitive");
    expect(result.proposals[1]?.consent_scopes).toEqual(["user_facing_review"]);

    const profile = await loadRelationshipProfile(baseDir);
    expect(profile.items.find((item) => item.stable_key === "user.imported_user_md")?.allowed_scopes).toEqual([
      "user_facing_review",
    ]);
    expect(formatRelationshipProfilePromptBlock(profile, "local_planning")).not.toContain("Prefer verbose status reports.");
    expect(formatRelationshipProfilePromptBlock(profile, "memory_retrieval")).not.toContain("Prefer concise status reports.");
  });

  it("applies approved USER.md proposals through the shared proposal approval path", async () => {
    const baseDir = makeTempDir();
    const result = await createRelationshipProfileProposalsFromUserMdImport({
      baseDir,
      importedUserContent: structuredUserMd(),
      now: "2026-05-03T00:00:00.000Z",
    });

    await approveRelationshipProfileChangeProposal(baseDir, result.proposals[0]!.id, {
      now: "2026-05-03T00:01:00.000Z",
    });
    await applyRelationshipProfileChangeProposal(baseDir, result.proposals[0]!.id, {
      now: "2026-05-03T00:02:00.000Z",
    });

    const profile = await loadRelationshipProfile(baseDir);
    expect(formatRelationshipProfilePromptBlock(profile, "memory_retrieval")).toContain("Prefer concise status reports.");
    expect(profile.audit_events.at(-1)?.proposal_id).toBe(result.proposals[0]!.id);
  });

  it("does not let stale raw imported text bypass a structured profile correction", async () => {
    const baseDir = makeTempDir();
    await seedRelationshipProfileFromSetup({
      baseDir,
      userName: "Imported USER.md",
      importedUserContent: structuredUserMd(),
      now: "2026-05-03T00:00:00.000Z",
    });
    await createRelationshipProfileProposalsFromUserMdImport({
      baseDir,
      importedUserContent: structuredUserMd(),
      now: "2026-05-03T00:01:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer terse status reports.",
      source: "user_correction",
      allowedScopes: ["local_planning", "memory_retrieval"],
      now: "2026-05-03T00:02:00.000Z",
    });

    const profile = await loadRelationshipProfile(baseDir);
    const proposals = await loadRelationshipProfileProposalStore(baseDir);
    const planningBlock = formatRelationshipProfilePromptBlock(profile, "local_planning");
    const retrievalBlock = formatRelationshipProfilePromptBlock(profile, "memory_retrieval");

    expect(proposals.proposals).toHaveLength(2);
    expect(proposals.proposals.every((proposal) => proposal.approval_state === "pending")).toBe(true);
    expect(planningBlock).toContain("Prefer terse status reports.");
    expect(retrievalBlock).toContain("Prefer terse status reports.");
    expect(planningBlock).not.toContain("Prefer verbose status reports.");
    expect(retrievalBlock).not.toContain("Prefer concise status reports.");
  });

  it("rejects applying stale setup import proposals after a newer structured correction", async () => {
    const baseDir = makeTempDir();
    const result = await createRelationshipProfileProposalsFromUserMdImport({
      baseDir,
      importedUserContent: structuredUserMd(),
      now: "2026-05-03T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer terse status reports.",
      source: "user_correction",
      allowedScopes: ["local_planning", "memory_retrieval"],
      now: "2026-05-03T00:01:00.000Z",
    });
    await approveRelationshipProfileChangeProposal(baseDir, result.proposals[0]!.id, {
      now: "2026-05-03T00:02:00.000Z",
    });

    await expect(applyRelationshipProfileChangeProposal(baseDir, result.proposals[0]!.id, {
      now: "2026-05-03T00:03:00.000Z",
    })).rejects.toThrow("stale setup import proposal");
    const profile = await loadRelationshipProfile(baseDir);
    expect(formatRelationshipProfilePromptBlock(profile, "memory_retrieval")).toContain("Prefer terse status reports.");
    expect(formatRelationshipProfilePromptBlock(profile, "memory_retrieval")).not.toContain("Prefer concise status reports.");
  });
});
