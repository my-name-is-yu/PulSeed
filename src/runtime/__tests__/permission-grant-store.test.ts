import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import {
  PermissionGrantRecordSchema,
  PermissionGrantStore,
  type PermissionGrantCreateInput,
} from "../store/permission-grant-store.js";

describe("PermissionGrantStore", () => {
  let tmpDir: string;
  let now: number;
  let store: PermissionGrantStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    now = 1_000;
    store = new PermissionGrantStore(tmpDir, { now: () => now });
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeGrant(overrides: Partial<PermissionGrantCreateInput> = {}): PermissionGrantCreateInput {
    return {
      grant_id: "grant-1",
      subject: {
        kind: "user",
        id: "user-1",
      },
      origin: {
        channel: "chat",
        platform: "local",
        conversation_id: "conversation-1",
        user_id: "user-1",
        session_id: "session-1",
        turn_id: "turn-1",
        message_id: "message-1",
      },
      source: {
        kind: "redacted_text",
        redacted_text: "[redacted] approved local edits and tests for this run",
        redaction_reason: "source may contain workspace details",
      },
      scope: {
        kind: "run",
        run_id: "run-1",
        goal_id: "goal-1",
        session_id: "session-1",
      },
      duration: {
        kind: "until_run_done",
      },
      capabilities: ["write_workspace", "run_tests"],
      excluded_capabilities: [
        "destructive_action",
        "write_remote",
        "network_send",
        "secret_change",
        "protected_path_mutation",
        "unknown_capability",
      ],
      staleness: {
        status: "fresh",
        checked_at: now,
        binding: {
          permission_state_epoch: 7,
          project_state_ref: "git:abc123",
          goal_state_ref: "goal:goal-1@2",
          session_state_ref: "session:session-1@3",
          surface_state_ref: "surface:current@4",
          relationship_state_ref: "relationship:user-1@5",
          world_state_ref: "world:local@6",
        },
      },
      audit_refs: ["audit:proposal-1"],
      ...overrides,
    };
  }

  it("round-trips proposed grants through the production runtime root layout", async () => {
    await store.ensureReady();
    const saved = await store.createProposed(makeGrant());

    expect(saved).toMatchObject({
      schema_version: "permission-grant-v1",
      grant_id: "grant-1",
      state: "proposed",
      state_version: 0,
      usage_count: 0,
      source: {
        kind: "redacted_text",
        redacted_text: "[redacted] approved local edits and tests for this run",
      },
      origin: {
        conversation_id: "conversation-1",
        session_id: "session-1",
      },
    });
    expect(await store.load("grant-1")).toEqual(saved);
    expect(fs.existsSync(path.join(tmpDir, "permission-grants", "grant-1.json"))).toBe(true);
  });

  it("rejects unsafe numeric scalars before storing grants", async () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.createActive(makeGrant({
      created_at: unsafeInteger,
    }))).rejects.toThrow();

    await expect(store.createActive(makeGrant({
      grant_id: "unsafe-expiry",
      duration: {
        kind: "expires_at",
        expires_at: unsafeInteger,
      },
    }))).rejects.toThrow();

    await expect(store.createActive(makeGrant({
      grant_id: "unsafe-review",
      scope: {
        kind: "workspace",
        workspace_root: "/repo",
      },
      duration: {
        kind: "standing",
      },
      review: {
        kind: "periodic",
        interval_ms: unsafeInteger,
        due_at: 2_000,
      },
    }))).rejects.toThrow();
  });

  it("skips persisted grants with unsafe numeric scalars during load and active listing", async () => {
    await store.createActive(makeGrant());
    const grantPath = path.join(tmpDir, "permission-grants", "grant-1.json");
    const persisted = JSON.parse(fs.readFileSync(grantPath, "utf-8")) as Record<string, unknown>;
    persisted.usage_count = Number.MAX_SAFE_INTEGER + 1;
    fs.writeFileSync(grantPath, JSON.stringify(persisted, null, 2), "utf-8");

    const reloaded = new PermissionGrantStore(tmpDir, { now: () => now });

    await expect(reloaded.load("grant-1")).resolves.toBeNull();
    await expect(reloaded.listActive()).resolves.toEqual([]);
  });

  it("activates, records use, and keeps active listing to fresh unexpired records", async () => {
    await store.createProposed(makeGrant());
    now = 1_100;
    const active = await store.activate("grant-1", { audit_refs: ["audit:activated"] });

    expect(active).toMatchObject({
      state: "active",
      activated_at: 1_100,
      state_version: 1,
      audit_refs: ["audit:proposal-1", "audit:activated"],
    });
    expect((await store.listActive()).map((grant) => grant.grant_id)).toEqual(["grant-1"]);

    now = 1_200;
    const used = await store.recordUse("grant-1", { audit_ref: "audit:reuse-1" });
    expect(used).toMatchObject({
      state: "active",
      usage_count: 1,
      last_used_at: 1_200,
      audit_refs: ["audit:proposal-1", "audit:activated", "audit:reuse-1"],
    });
  });

  it("excludes expired, revoked, superseded, stale, and consumed-once grants from active listing", async () => {
    await store.createActive(makeGrant({ grant_id: "active-run" }));
    await store.createActive(makeGrant({
      grant_id: "expired-by-time",
      duration: {
        kind: "expires_at",
        expires_at: 1_050,
      },
    }));
    await store.createActive(makeGrant({ grant_id: "revoked-run" }));
    await store.createActive(makeGrant({ grant_id: "superseded-run" }));
    await store.createActive(makeGrant({ grant_id: "stale-run" }));
    await store.createActive(makeGrant({
      grant_id: "once-run",
      duration: {
        kind: "once",
      },
    }));

    now = 1_100;
    await store.revoke("revoked-run", {
      revoked_by: "user-1",
      reason: "user revoked the run permission",
    });
    await store.supersede("superseded-run", makeGrant({ grant_id: "replacement-run" }));
    await store.markStale("stale-run", {
      reason: "session state no longer matches the grant binding",
    });
    await store.recordUse("once-run");

    expect((await store.listActive()).map((grant) => grant.grant_id)).toEqual(["active-run"]);
  });

  it("requires review for standing grants and renews them without losing audit history", async () => {
    await expect(store.createActive(makeGrant({
      grant_id: "standing-missing-review",
      scope: {
        kind: "workspace",
        workspace_root: "/repo",
      },
      duration: {
        kind: "standing",
      },
    }))).rejects.toThrow(/standing permission grants require an explicit review policy/);

    await store.createActive(makeGrant({
      grant_id: "standing-workspace",
      scope: {
        kind: "workspace",
        workspace_root: "/repo",
      },
      duration: {
        kind: "standing",
      },
      review: {
        kind: "periodic",
        interval_ms: 500,
        due_at: 1_200,
        last_reviewed_at: 700,
      },
      audit_refs: ["audit:standing-created"],
    }));

    now = 1_100;
    expect((await store.listActive()).map((grant) => grant.grant_id)).toEqual(["standing-workspace"]);

    now = 1_250;
    expect(await store.listActive()).toEqual([]);

    await store.review("standing-workspace", {
      reviewed_at: 1_300,
      next_review_due_at: 2_000,
      audit_refs: ["audit:standing-reviewed"],
    });

    expect(await store.load("standing-workspace")).toMatchObject({
      state: "active",
      review: {
        kind: "periodic",
        due_at: 2_000,
        last_reviewed_at: 1_300,
      },
      audit_refs: ["audit:standing-created", "audit:standing-reviewed"],
    });
    expect((await store.listActive()).map((grant) => grant.grant_id)).toEqual(["standing-workspace"]);
  });

  it("rejects unsafe review updates without corrupting the existing grant", async () => {
    await store.createActive(makeGrant({
      grant_id: "standing-workspace",
      scope: {
        kind: "workspace",
        workspace_root: "/repo",
      },
      duration: {
        kind: "standing",
      },
      review: {
        kind: "periodic",
        interval_ms: 500,
        due_at: 1_200,
        last_reviewed_at: 700,
      },
      audit_refs: ["audit:standing-created"],
    }));

    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;
    await expect(store.review("standing-workspace", {
      reviewed_at: unsafeInteger,
      next_review_due_at: unsafeInteger,
      audit_refs: ["audit:unsafe-review"],
    })).rejects.toThrow();

    expect(await store.load("standing-workspace")).toMatchObject({
      review: {
        kind: "periodic",
        due_at: 1_200,
        last_reviewed_at: 700,
      },
      audit_refs: ["audit:standing-created"],
    });
  });

  it("persists revocation across restart-like store reload", async () => {
    await store.createActive(makeGrant());
    now = 1_500;
    await store.revoke("grant-1", {
      revoked_by: "user-1",
      reason: "stop using this permission",
      audit_refs: ["audit:revoked"],
    });

    const reloaded = new PermissionGrantStore(tmpDir, { now: () => now });
    expect(await reloaded.load("grant-1")).toMatchObject({
      state: "revoked",
      revoked_at: 1_500,
      revoked_by: "user-1",
      revocation_reason: "stop using this permission",
    });
    expect(await reloaded.listActive()).toEqual([]);
  });

  it("does not reactivate revoked grants", async () => {
    await store.createActive(makeGrant());
    await store.revoke("grant-1", {
      revoked_by: "user-1",
      reason: "stop using this permission",
    });

    now = 1_700;
    const unchanged = await store.activate("grant-1", { audit_refs: ["audit:late-activate"] });

    expect(unchanged).toMatchObject({
      state: "revoked",
      revoked_by: "user-1",
    });
    expect(unchanged?.audit_refs).not.toContain("audit:late-activate");
    expect(await store.listActive()).toEqual([]);
  });

  it("superseding preserves old grant auditability and links to the replacement", async () => {
    await store.createActive(makeGrant());
    now = 2_000;
    const result = await store.supersede("grant-1", makeGrant({
      grant_id: "grant-2",
      capabilities: ["run_tests"],
      source: {
        kind: "source_ref",
        ref: "runtime-message://conversation-1/message-2",
        redaction_reason: "raw approval text retained in the message ledger",
      },
    }), {
      audit_refs: ["audit:superseded"],
    });

    expect(result?.superseded).toMatchObject({
      grant_id: "grant-1",
      state: "superseded",
      superseded_at: 2_000,
      superseded_by: "grant-2",
      audit_refs: ["audit:proposal-1", "audit:superseded"],
    });
    expect(result?.replacement).toMatchObject({
      grant_id: "grant-2",
      state: "proposed",
      supersedes: ["grant-1"],
      source: {
        kind: "source_ref",
        ref: "runtime-message://conversation-1/message-2",
      },
    });
  });

  it("rejects unsafe supersede timestamps before writing a replacement grant", async () => {
    await store.createActive(makeGrant());
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.supersede("grant-1", makeGrant({
      grant_id: "grant-unsafe-replacement",
      created_at: 2_000,
    }), {
      superseded_at: unsafeInteger,
    })).rejects.toThrow();

    await expect(store.load("grant-unsafe-replacement")).resolves.toBeNull();
    const original = await store.load("grant-1");
    expect(original).toMatchObject({
      grant_id: "grant-1",
      state: "active",
    });
    expect(original).not.toHaveProperty("superseded_by");
  });

  it("validates lifecycle invariants before persistence", () => {
    expect(() => PermissionGrantRecordSchema.parse({
      schema_version: "permission-grant-v1",
      grant_id: "invalid-active",
      subject: {
        kind: "user",
        id: "user-1",
      },
      origin: {
        channel: "chat",
      },
      source: {
        kind: "source_ref",
        ref: "runtime-message://message-1",
      },
      scope: {
        kind: "run",
        run_id: "run-1",
      },
      duration: {
        kind: "until_run_done",
      },
      review: {
        kind: "none",
      },
      capabilities: ["write_workspace"],
      state: "active",
      state_version: 0,
      state_epoch: 1,
      created_at: 1,
      updated_at: 1,
    })).toThrow(/active permission grants require activated_at/);
  });
});
