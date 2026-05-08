import { describe, expect, it } from "vitest";
import {
  GovernedMemorySchema,
  requiredGovernedMemoryDomainFields,
} from "../governed-memory.js";

const now = "2026-05-08T00:00:00.000Z";

function makeMemory(overrides: Record<string, unknown> = {}) {
  return {
    id: "memory-1",
    owner_ref: {
      kind: "relationship_profile",
      store_ref: "relationship-profile.json",
      record_ref: "profile-item-1",
    },
    role: "profile",
    record_kind: "preference",
    lifecycle: "active",
    domain_fields: {
      subject: "status reports",
      preference: "concise",
    },
    content: {
      state: "materialized",
      text: "The user prefers concise status reports.",
    },
    epistemic_status: "reported_by_user",
    confidence: 0.9,
    source_reliability: 0.9,
    sensitivity: "private",
    projection_policy: {
      allowed_uses: ["surface_projection", "memory_retrieval"],
      forbidden_uses: ["resident_behavior"],
      requires_permission_gate: true,
      surface_eligible: true,
    },
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("GovernedMemory contract", () => {
  it("requires an explicit owner before memory can enter Surface consideration", () => {
    const parsed = GovernedMemorySchema.parse(makeMemory());
    expect(parsed.owner_ref.kind).toBe("relationship_profile");
    expect(parsed.owner_ref.store_ref).toBe("relationship-profile.json");

    const withoutOwner = { ...makeMemory() };
    delete (withoutOwner as { owner_ref?: unknown }).owner_ref;
    expect(GovernedMemorySchema.safeParse(withoutOwner).success).toBe(false);
  });

  it("validates record-kind-specific domain fields", () => {
    for (const field of requiredGovernedMemoryDomainFields("boundary")) {
      expect(field).toBeTruthy();
    }

    const missingScope = GovernedMemorySchema.safeParse(makeMemory({
      record_kind: "boundary",
      domain_fields: {
        boundary: "Do not use private health context for resident behavior.",
      },
    }));
    expect(missingScope.success).toBe(false);

    const boundary = GovernedMemorySchema.parse(makeMemory({
      record_kind: "boundary",
      domain_fields: {
        boundary: "Do not use private health context for resident behavior.",
        scope: "resident_behavior",
      },
    }));
    expect(boundary.record_kind).toBe("boundary");
  });

  it("keeps allowed use separate from permission and rejects contradictory policy", () => {
    const parsed = GovernedMemorySchema.parse(makeMemory());
    expect(parsed.projection_policy.requires_permission_gate).toBe(true);
    expect("permission_grant" in parsed).toBe(false);

    const contradictory = GovernedMemorySchema.safeParse(makeMemory({
      projection_policy: {
        allowed_uses: ["surface_projection"],
        forbidden_uses: ["surface_projection"],
      },
    }));
    expect(contradictory.success).toBe(false);
  });

  it("requires tombstoned and deleted records to be redacted refs instead of reconstructable text", () => {
    expect(GovernedMemorySchema.safeParse(makeMemory({
      lifecycle: "deleted",
      content: {
        state: "materialized",
        text: "This old deleted content must not survive.",
      },
    })).success).toBe(false);

    const redacted = GovernedMemorySchema.parse(makeMemory({
      lifecycle: "tombstoned",
      content: {
        state: "redacted",
        redaction_ref: "redaction/profile-item-1",
        reason: "tombstoned",
      },
      projection_policy: {
        allowed_uses: ["audit_only"],
        forbidden_uses: ["surface_projection"],
        surface_eligible: false,
      },
    }));
    expect(redacted.content.state).toBe("redacted");
  });

  it("rejects non-active lifecycle records from normal Surface projection", () => {
    for (const lifecycle of ["suppressed", "superseded", "retracted", "retired", "seed_candidate"] as const) {
      const parsed = GovernedMemorySchema.safeParse(makeMemory({ lifecycle }));
      expect(parsed.success, lifecycle).toBe(false);
    }

    const auditOnly = GovernedMemorySchema.parse(makeMemory({
      lifecycle: "superseded",
      projection_policy: {
        allowed_uses: ["audit_only"],
        forbidden_uses: ["surface_projection"],
        surface_eligible: false,
      },
    }));
    expect(auditOnly.lifecycle).toBe("superseded");
  });

  it("rejects active redacted records that still allow normal Surface projection", () => {
    const parsed = GovernedMemorySchema.safeParse(makeMemory({
      content: {
        state: "redacted",
        redaction_ref: "redaction/memory-1",
        reason: "sensitive",
      },
      projection_policy: {
        allowed_uses: ["surface_projection"],
        forbidden_uses: ["resident_behavior"],
        surface_eligible: false,
      },
    }));

    expect(parsed.success).toBe(false);
  });
});
