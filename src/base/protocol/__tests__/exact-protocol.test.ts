import { describe, expect, it } from "vitest";
import {
  EXACT_PROTOCOL_SURFACE_DEFINITIONS,
  EXACT_PROTOCOL_SURFACES,
  isExactProtocolSurface,
  isExactSlashCommandInput,
  parseExactMentionToken,
  parseExactSlashCommand,
  parseExactSlashCommandToken,
} from "../exact-protocol.js";

describe("exact protocol boundary", () => {
  it("declares the deterministic surfaces allowed by the semantic policy", () => {
    expect(EXACT_PROTOCOL_SURFACES).toEqual([
      "slash_command",
      "cli_flag",
      "id",
      "path",
      "url",
      "enum_schema",
      "feature_flag",
      "wire_token",
      "mention",
    ]);
    expect(EXACT_PROTOCOL_SURFACE_DEFINITIONS.map((definition) => definition.surface)).toEqual(
      EXACT_PROTOCOL_SURFACES,
    );
    expect(isExactProtocolSurface("mention")).toBe(true);
    expect(isExactProtocolSurface("freeform_keyword")).toBe(false);
  });

  it("parses exact slash commands without accepting bare command-like words", () => {
    const definitions = [
      { command: "/help" },
      { command: "/status", allowArguments: true },
      { command: "/goals", aliases: ["/goal list"] },
    ] as const;

    expect(parseExactSlashCommand("/HELP", definitions)).toMatchObject({
      command: "/help",
      alias: "/help",
      rawArgs: "",
    });
    expect(parseExactSlashCommand("/status goal-123", definitions)).toMatchObject({
      command: "/status",
      rawArgs: "goal-123",
    });
    expect(parseExactSlashCommand("/goal list", definitions)).toMatchObject({
      command: "/goals",
      alias: "/goal list",
    });

    expect(parseExactSlashCommand("help", definitions)).toBeNull();
    expect(parseExactSlashCommand("show me status", definitions)).toBeNull();
    expect(parseExactSlashCommand("status please", definitions)).toBeNull();
    expect(parseExactSlashCommand("please run /status", definitions)).toBeNull();
  });

  it("keeps slash token parsing limited to leading slash grammar", () => {
    expect(isExactSlashCommandInput("/settings")).toBe(true);
    expect(parseExactSlashCommandToken("  /settings open  ")).toMatchObject({
      command: "/settings",
      rawArgs: "open",
    });
    expect(isExactSlashCommandInput("open settings")).toBe(false);
    expect(isExactSlashCommandInput("settings, please")).toBe(false);
    expect(parseExactSlashCommandToken("please use /settings")).toBeNull();
  });

  it("parses exact mention tokens without deriving targets from prose", () => {
    expect(parseExactMentionToken("@run:run-123")).toEqual({
      surface: "mention",
      rawInput: "@run:run-123",
      kind: "run",
      id: "run-123",
      target: "run:run-123",
    });
    expect(parseExactMentionToken("@session:conversation:abc")).toMatchObject({
      kind: "session",
      id: "conversation:abc",
      target: "session:conversation:abc",
    });

    expect(parseExactMentionToken("run-123")).toBeNull();
    expect(parseExactMentionToken("please mention @run:run-123")).toBeNull();
    expect(parseExactMentionToken("@latest")).toBeNull();
    expect(parseExactMentionToken("@title:Current Work")).toBeNull();
  });
});
