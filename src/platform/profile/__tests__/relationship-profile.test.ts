import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatRelationshipProfilePromptBlock,
  getRelationshipProfileHistory,
  loadRelationshipProfile,
  relationshipProfilePath,
  retractRelationshipProfileItem,
  seedRelationshipProfileFromSetup,
  selectActiveRelationshipProfileItems,
  upsertRelationshipProfileItem,
} from "../relationship-profile.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-relationship-profile-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("relationship profile store", () => {
  it("versions preference changes and rejects stale active items", async () => {
    const baseDir = makeTempDir();

    const first = await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "The user prefers Atom.",
      source: "cli_update",
      allowedScopes: ["local_planning", "resident_behavior"],
      now: "2026-05-02T00:00:00.000Z",
    });
    const second = await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "The user prefers VS Code.",
      source: "user_correction",
      allowedScopes: ["local_planning", "resident_behavior"],
      now: "2026-05-02T01:00:00.000Z",
    });

    const store = await loadRelationshipProfile(baseDir);
    expect(first.item.version).toBe(1);
    expect(second.item.version).toBe(2);
    expect(second.superseded.map((item) => item.id)).toEqual([first.item.id]);
    expect(store.items.find((item) => item.id === first.item.id)?.status).toBe("superseded");

    const active = selectActiveRelationshipProfileItems(store, "local_planning");
    expect(active).toHaveLength(1);
    expect(active[0]?.value).toBe("The user prefers VS Code.");

    const block = formatRelationshipProfilePromptBlock(store, "local_planning");
    expect(block).toContain("The user prefers VS Code.");
    expect(block).not.toContain("The user prefers Atom.");
  });

  it("rejects persisted profile items with unsafe versions", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "The user prefers VS Code.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T00:00:00.000Z",
    });

    const persisted = JSON.parse(fs.readFileSync(relationshipProfilePath(baseDir), "utf-8")) as {
      items: Array<{ version: number }>;
    };
    persisted.items[0]!.version = Number.MAX_SAFE_INTEGER + 1;
    fs.writeFileSync(relationshipProfilePath(baseDir), JSON.stringify(persisted, null, 2), "utf-8");

    const store = await loadRelationshipProfile(baseDir);
    expect(store.items).toEqual([]);
    expect(store.audit_events).toEqual([]);
  });

  it("tracks active to superseded to retracted lifecycle and keeps stale items out of scoped context", async () => {
    const baseDir = makeTempDir();

    const first = await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "The user prefers Atom.",
      source: "cli_update",
      allowedScopes: ["local_planning", "resident_behavior", "memory_retrieval", "user_facing_review"],
      evidenceRef: "cli:first",
      now: "2026-05-02T00:00:00.000Z",
    });
    const second = await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "The user prefers VS Code.",
      source: "user_correction",
      allowedScopes: ["local_planning", "resident_behavior", "memory_retrieval", "user_facing_review"],
      evidenceRef: "cli:second",
      now: "2026-05-02T01:00:00.000Z",
    });
    const retracted = await retractRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      reason: "User said this preference is no longer true.",
      source: "cli_update",
      now: "2026-05-02T02:00:00.000Z",
    });

    const store = await loadRelationshipProfile(baseDir);
    expect(first.item.version).toBe(1);
    expect(second.item.version).toBe(2);
    expect(retracted.item.id).toBe(second.item.id);
    expect(store.items.find((item) => item.id === first.item.id)?.status).toBe("superseded");
    expect(store.items.find((item) => item.id === second.item.id)?.status).toBe("retracted");

    for (const scope of ["local_planning", "resident_behavior", "memory_retrieval", "user_facing_review"] as const) {
      expect(selectActiveRelationshipProfileItems(store, scope)).toHaveLength(0);
      expect(formatRelationshipProfilePromptBlock(store, scope)).not.toContain("VS Code");
      expect(formatRelationshipProfilePromptBlock(store, scope)).not.toContain("Atom");
    }

    const history = getRelationshipProfileHistory(store, "user.preference.editor");
    expect(history.items.map((item) => [item.version, item.status])).toEqual([
      [1, "superseded"],
      [2, "retracted"],
    ]);
    expect(history.audit_events.map((event) => event.action)).toEqual(["seeded", "superseded", "created", "retracted"]);
    expect(history.audit_events.at(-1)?.reason).toBe("User said this preference is no longer true.");
  });

  it("rejects retracting a stale key without an active item", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "The user prefers VS Code.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await retractRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      reason: "No longer current.",
      now: "2026-05-02T01:00:00.000Z",
    });

    await expect(retractRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.editor",
      reason: "Second retract should fail.",
      now: "2026-05-02T02:00:00.000Z",
    })).rejects.toThrow("no active relationship profile item found");
  });

  it("keeps sensitive boundary items out of prompts unless explicitly allowed", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.boundary.health",
      kind: "boundary",
      value: "Do not use health context outside explicit review.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["local_planning", "user_facing_review"],
      now: "2026-05-02T00:00:00.000Z",
    });

    const store = await loadRelationshipProfile(baseDir);
    expect(formatRelationshipProfilePromptBlock(store, "local_planning")).not.toContain("health context");
    expect(formatRelationshipProfilePromptBlock(store, "local_planning", { includeSensitive: true })).toContain("health context");
  });

  it("seeds setup identity separately from USER.md compatibility", async () => {
    const baseDir = makeTempDir();
    await seedRelationshipProfileFromSetup({
      baseDir,
      userName: "Yu",
      importedUserContent: "# About You\n\nPrefer concise status reports.",
      now: "2026-05-02T00:00:00.000Z",
    });

    const store = await loadRelationshipProfile(baseDir);
    expect(fs.existsSync(relationshipProfilePath(baseDir))).toBe(true);
    expect(store.items.map((item) => item.stable_key).sort()).toEqual([
      "user.identity.name",
      "user.imported_user_md",
    ]);
    expect(store.items.find((item) => item.stable_key === "user.identity.name")?.allowed_scopes).toContain("resident_behavior");
    expect(store.items.find((item) => item.stable_key === "user.imported_user_md")?.allowed_scopes).toEqual([
      "user_facing_review",
    ]);
    expect(store.items.find((item) => item.stable_key === "user.imported_user_md")?.value).toContain("Prefer concise");
  });

  it("does not feed raw imported USER.md into planning prompts after structured corrections", async () => {
    const baseDir = makeTempDir();
    await seedRelationshipProfileFromSetup({
      baseDir,
      userName: "Imported USER.md",
      importedUserContent: "# About You\n\nPrefer verbose status reports.",
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "user_correction",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T01:00:00.000Z",
    });

    const store = await loadRelationshipProfile(baseDir);
    const block = formatRelationshipProfilePromptBlock(store, "local_planning");
    expect(block).toContain("Prefer concise status reports.");
    expect(block).not.toContain("Prefer verbose status reports.");
  });
});
