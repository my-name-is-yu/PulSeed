import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Mocks (hoisted) ───

const mockReadFileSync = vi.fn();
const mockExistsSync = vi.fn();

vi.mock("node:fs", () => ({
  default: {
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
  },
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock("../../../base/utils/paths.js", () => ({
  getPulseedDirPath: () => "/tmp/fake-pulseed-home",
}));

// Import AFTER mocks are set up (vi.mock is hoisted by vitest)
const {
  loadIdentity,
  clearIdentityCache,
  getAgentName,
  getInternalIdentityPrefix,
  getRuntimeIdentitySlotContent,
  getSelfIdentityResponse,
  getSelfIdentityResponseForBaseDir,
  getUserFacingIdentity,
  DEFAULT_SEED,
  DEFAULT_ROOT,
  DEFAULT_USER,
} = await import("../identity-loader.js");

// ─── Helpers ───

function noFiles(): void {
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockImplementation((p: string) => {
    throw new Error(`ENOENT: no such file or directory: ${p}`);
  });
}

function withFile(filename: string, content: string): void {
  mockExistsSync.mockImplementation((p: string) => p.endsWith(filename));
  mockReadFileSync.mockImplementation((p: string) => {
    if (p.endsWith(filename)) return content;
    throw new Error(`ENOENT: ${p}`);
  });
}

function withFiles(files: Record<string, string>): void {
  mockExistsSync.mockImplementation((p: string) =>
    Object.keys(files).some((name) => p.endsWith(name))
  );
  mockReadFileSync.mockImplementation((p: string) => {
    const match = Object.keys(files).find((name) => p.endsWith(name));
    if (match) return files[match];
    throw new Error(`ENOENT: ${p}`);
  });
}

// ─── Tests ───

describe("loadIdentity()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("returns defaults when no files exist", () => {
    noFiles();
    const identity = loadIdentity();
    expect(identity.name).toBe("Seedy");
    expect(identity.seed).toBe(DEFAULT_SEED);
    expect(identity.root).toBe(DEFAULT_ROOT);
    expect(identity.user).toBe(DEFAULT_USER);
  });

  it("reads SEED.md when it exists", () => {
    const custom = `# MySeed
Custom seed content.`;
    withFile("SEED.md", custom);
    const identity = loadIdentity();
    expect(identity.seed).toBe(custom);
  });

  it("reads ROOT.md when it exists", () => {
    const custom = `# MyRoot
Custom root content.`;
    withFile("ROOT.md", custom);
    const identity = loadIdentity();
    expect(identity.root).toBe(custom);
  });

  it("reads USER.md when it exists", () => {
    const custom = `# User
Custom user content.`;
    withFile("USER.md", custom);
    const identity = loadIdentity();
    expect(identity.user).toBe(custom);
  });

  it("caches result — file is only read once", () => {
    noFiles();
    loadIdentity();
    loadIdentity();
    // existsSync (or readFileSync) should not double-call once cached
    const callCount = mockExistsSync.mock.calls.length;
    loadIdentity(); // third call
    expect(mockExistsSync.mock.calls.length).toBe(callCount); // no new calls
  });

  it("combines multiple custom files", () => {
    withFiles({
      "SEED.md": "# CustomSeed",
      "ROOT.md": "custom root",
    });
    const identity = loadIdentity();
    expect(identity.seed).toBe("# CustomSeed");
    expect(identity.root).toBe("custom root");
    expect(identity.user).toBe(DEFAULT_USER);
  });
});

describe("clearIdentityCache()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("forces re-read on next call after clearing cache", () => {
    noFiles();
    loadIdentity(); // prime cache
    const callsAfterFirst = mockReadFileSync.mock.calls.length;

    clearIdentityCache();
    loadIdentity(); // should re-read
    expect(mockReadFileSync.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("getAgentName()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it('returns "Seedy" by default', () => {
    noFiles();
    expect(getAgentName()).toBe("Seedy");
  });

  it("returns custom name from SEED.md heading", () => {
    withFile("SEED.md", `# Pebble
Some content.`);
    expect(getAgentName()).toBe("Pebble");
  });

  it('falls back to "Seedy" when SEED.md has no h1 heading', () => {
    withFile("SEED.md", "No heading here, just content.");
    expect(getAgentName()).toBe("Seedy");
  });
});

describe("getInternalIdentityPrefix()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
    noFiles();
  });

  it("returns a string mentioning Seedy and the role", () => {
    const result = getInternalIdentityPrefix("morning planner");
    expect(result).toContain("Seedy");
    expect(result).toContain("morning planner");
  });

  it("returns expected default prefix", () => {
    const result = getInternalIdentityPrefix("morning planner");
    expect(result).toBe("You are Seedy, PulSeed's morning planner. Seedy is the configured agent identity running PulSeed, an AI agent orchestration system.");
  });

  it("uses custom agent name when SEED.md sets one", () => {
    withFile("SEED.md", `# Pebble
Content here.`);
    clearIdentityCache();
    const result = getInternalIdentityPrefix("planner");
    expect(result).toContain("Pebble");
  });

  it("adds only active relationship profile items for the requested scope", () => {
    withFiles({
      "relationship-profile.json": JSON.stringify({
        schema_version: 1,
        profile_id: "default",
        updated_at: "2026-05-02T00:00:00.000Z",
        items: [
          {
            id: "current",
            stable_key: "user.preference.status",
            kind: "preference",
            value: "Prefer concise status reports.",
            status: "active",
            version: 2,
            confidence: 0.9,
            sensitivity: "private",
            allowed_scopes: ["local_planning"],
            provenance: { source: "cli_update" },
            created_at: "2026-05-02T00:00:00.000Z",
            updated_at: "2026-05-02T00:00:00.000Z",
            superseded_at: null,
            superseded_by: null,
          },
          {
            id: "old",
            stable_key: "user.preference.status",
            kind: "preference",
            value: "Prefer verbose status reports.",
            status: "superseded",
            version: 1,
            confidence: 0.9,
            sensitivity: "private",
            allowed_scopes: ["local_planning"],
            provenance: { source: "cli_update" },
            created_at: "2026-05-01T00:00:00.000Z",
            updated_at: "2026-05-02T00:00:00.000Z",
            superseded_at: "2026-05-02T00:00:00.000Z",
            superseded_by: "current",
          },
        ],
        audit_events: [],
      }),
    });
    const result = getInternalIdentityPrefix("planner", { profileScope: "local_planning" });
    expect(result).toContain("Prefer concise status reports.");
    expect(result).not.toContain("Prefer verbose status reports.");
  });

  it("keeps stale and sensitive boundaries out of lower-trust planning prompts unless explicitly allowed", () => {
    withFiles({
      "relationship-profile.json": JSON.stringify({
        schema_version: 1,
        profile_id: "default",
        updated_at: "2026-05-03T00:00:00.000Z",
        items: [
          {
            id: "old-boundary",
            stable_key: "user.boundary.notifications",
            kind: "boundary",
            value: "Notify freely.",
            status: "superseded",
            version: 1,
            confidence: 0.9,
            sensitivity: "private",
            allowed_scopes: ["local_planning", "user_facing_review"],
            provenance: { source: "cli_update" },
            created_at: "2026-05-02T00:00:00.000Z",
            updated_at: "2026-05-03T00:00:00.000Z",
            superseded_at: "2026-05-03T00:00:00.000Z",
            superseded_by: "new-boundary",
          },
          {
            id: "new-boundary",
            stable_key: "user.boundary.notifications",
            kind: "boundary",
            value: "Ask before non-urgent notifications.",
            status: "active",
            version: 2,
            confidence: 0.9,
            sensitivity: "private",
            allowed_scopes: ["local_planning", "user_facing_review"],
            provenance: { source: "user_correction" },
            created_at: "2026-05-03T00:00:00.000Z",
            updated_at: "2026-05-03T00:00:00.000Z",
            superseded_at: null,
            superseded_by: null,
          },
          {
            id: "sensitive-boundary",
            stable_key: "user.boundary.health",
            kind: "boundary",
            value: "Do not use health context outside explicit review.",
            status: "active",
            version: 1,
            confidence: 0.8,
            sensitivity: "sensitive",
            allowed_scopes: ["local_planning", "user_facing_review"],
            provenance: { source: "cli_update" },
            created_at: "2026-05-03T00:00:00.000Z",
            updated_at: "2026-05-03T00:00:00.000Z",
            superseded_at: null,
            superseded_by: null,
          },
        ],
        audit_events: [],
      }),
    });

    const defaultPrompt = getInternalIdentityPrefix("planner", { profileScope: "local_planning" });
    expect(defaultPrompt).toContain("Ask before non-urgent notifications.");
    expect(defaultPrompt).not.toContain("Notify freely.");
    expect(defaultPrompt).not.toContain("health context");

    const explicitSensitivePrompt = getInternalIdentityPrefix("planner", {
      profileScope: "local_planning",
      includeSensitiveProfile: true,
    });
    expect(explicitSensitivePrompt).toContain("Do not use health context outside explicit review.");
  });
});

describe("runtime identity slot", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("states that runtime identity files own self-identity", () => {
    noFiles();
    const result = getRuntimeIdentitySlotContent();
    expect(result).toContain("SEED.md, ROOT.md, and USER.md");
    expect(result).toContain("Active agent name: Seedy");
    expect(result).toContain("configured agent running PulSeed");
    expect(result).toContain("Do not identify as Codex, Claude, ChatGPT");
  });

  it("answers self-identity from the configured SEED.md agent name in English by default", () => {
    withFile("SEED.md", "# Sprout\n\nCustom identity.");
    const result = getSelfIdentityResponse();
    expect(result).toContain("I am Sprout");
    expect(result).toContain("SEED.md/ROOT.md/USER.md");
    expect(result).toContain("runtime identity");
    expect(result).not.toContain("I am Codex");
    expect(result).not.toContain("I am Claude");
    expect(result).not.toContain("I am ChatGPT");
  });

  it("answers English self-identity questions from the same runtime slot", () => {
    withFile("SEED.md", "# Sprout\n\nCustom identity.");
    const result = getSelfIdentityResponse("en");
    expect(result).toContain("I am Sprout");
    expect(result).toContain("SEED.md/ROOT.md/USER.md");
    expect(result).toContain("runtime identity");
    expect(result).not.toContain("I am Codex");
    expect(result).not.toContain("I am Claude");
    expect(result).not.toContain("I am ChatGPT");
  });

  it("keeps the legacy Japanese language option on the English public identity response", () => {
    withFile("SEED.md", "# Sprout\n\nCustom identity.");
    const result = getSelfIdentityResponse("ja");
    expect(result).toContain("I am Sprout");
    expect(result).toContain("SEED.md/ROOT.md/USER.md");
    expect(result).toContain("runtime identity");
    expect(result).not.toContain("私は");
    expect(result).not.toContain("I am Codex");
    expect(result).not.toContain("I am Claude");
    expect(result).not.toContain("I am ChatGPT");
  });

  it("can answer self-identity from an explicit runtime base dir without using global cache", () => {
    noFiles();
    loadIdentity();
    const result = getSelfIdentityResponseForBaseDir("/isolated/runtime-home", "en");

    expect(result).toContain("I am Seedy");
    expect(mockReadFileSync).toHaveBeenCalledWith("/isolated/runtime-home/SEED.md", "utf-8");
  });
});

describe("getUserFacingIdentity()", () => {
  beforeEach(() => {
    clearIdentityCache();
    mockReadFileSync.mockReset();
    mockExistsSync.mockReset();
  });

  it("contains seed and root content", () => {
    noFiles();
    const result = getUserFacingIdentity();
    expect(result).toContain(DEFAULT_SEED);
    expect(result).toContain(DEFAULT_ROOT);
    expect(result).toContain("Runtime Identity Slot");
  });

  it("includes user content when USER.md has real content", () => {
    const customUser = `# User preferences
I prefer concise answers.`;
    withFile("USER.md", customUser);
    const result = getUserFacingIdentity();
    expect(result).toContain(customUser);
  });

  it("omits user section when USER.md is just the template/comments", () => {
    // Template-only USER.md: only HTML comments, no real content
    const templateUser =
      `<!-- This file is auto-generated. Add your preferences below. -->`;
    withFile("USER.md", templateUser);
    clearIdentityCache();
    const result = getUserFacingIdentity();
    // Should not include the template boilerplate in output
    expect(result).not.toContain("auto-generated");
  });

  it("returns a non-empty prompt even when no user files exist", () => {
    noFiles(); // falls back to defaults
    const result = getUserFacingIdentity();
    // Should always contain the default seed and root content
    expect(result).toContain(DEFAULT_SEED.trim());
    expect(result).toContain(DEFAULT_ROOT.trim());
    expect(result.length).toBeGreaterThan(0);
  });

  it("default root text prefers direct tool execution over delegate-only behavior", () => {
    noFiles();
    const result = getUserFacingIdentity();
    expect(result).toContain("I use available tools directly when that moves the goal forward safely");
    expect(result).not.toContain("I orchestrate, I don't execute tasks directly");
    expect(result).not.toContain("I always delegate to agents and observe results");
  });
});
