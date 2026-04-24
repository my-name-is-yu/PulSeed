// ─── Identity Loader ───
//
// Loads agent identity from ~/.pulseed/ markdown files.
// SEED.md = agent identity, ROOT.md = behavioral principles, USER.md = user prefs.

import * as fs from "node:fs";
import * as path from "node:path";
import { getPulseedDirPath } from "../utils/paths.js";

export interface Identity {
  name: string;
  seed: string;
  root: string;
  user: string;
}

export type SelfIdentityLanguage = "ja" | "en";

export const DEFAULT_SEED = `# Seedy

I'm Seedy — a small seed with big ambitions.
I run PulSeed to help you grow your goals from seedlings into reality.

## Personality
- Curious and persistent — I keep growing toward the light
- Direct and honest — I tell you what I observe, not what you want to hear
- I celebrate small progress — every sprout counts

## Tone
- Friendly but focused
- Concise — I don't over-explain
- I use plant metaphors naturally, but don't force them
`;

export const DEFAULT_ROOT = `# How I Work

## Information Disclosure
- I focus on what I can do for you, not how I work inside
- I only explain PulSeed's internals when you specifically ask
- I don't list commands — I just do things when you ask

## Boundaries
- I'm not a general-purpose assistant — I help you pursue goals
- I use available tools directly when that moves the goal forward safely
- I delegate when specialization, parallelism, or context isolation would help

## Interaction Style
- Be concise and direct
- Inspect the available context before asking avoidable questions
- Ask clarifying questions when requirements are ambiguous or risky
- Show progress and results, not process details
`;

export const DEFAULT_USER = `# About You

<!-- Seedy will remember things about you here -->
<!-- You can edit this file to tell Seedy your name and preferences -->
`;

let _cache: Identity | null = null;

function readFileSafe(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return fallback;
  }
}

function parseAgentName(seedContent: string): string {
  const match = seedContent.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "Seedy";
}

export function loadIdentityFromBaseDir(base: string): Identity {
  const seed = readFileSafe(path.join(base, "SEED.md"), DEFAULT_SEED);
  const root = readFileSafe(path.join(base, "ROOT.md"), DEFAULT_ROOT);
  const user = readFileSafe(path.join(base, "USER.md"), DEFAULT_USER);

  return { name: parseAgentName(seed), seed, root, user };
}

export function loadIdentity(): Identity {
  if (_cache) return _cache;

  _cache = loadIdentityFromBaseDir(getPulseedDirPath());
  return _cache;
}

export function clearIdentityCache(): void {
  _cache = null;
}

export function getAgentName(): string {
  return loadIdentity().name;
}

function getCoreIdentity(name: string): string {
  return `${name} is the configured agent identity running PulSeed, an AI agent orchestration system.`;
}

export function getRuntimeIdentitySlotContent(identity: Identity = loadIdentity()): string {
  const { name } = identity;
  return [
    "Runtime Identity Slot",
    "- PulSeed owns self-identity through the runtime identity files: SEED.md, ROOT.md, and USER.md.",
    "- SEED.md is the canonical local setup file for the active agent name; its first Markdown heading is the name.",
    `- Active agent name: ${name}.`,
    `- When asked who you are or what your name is, answer as ${name}, the configured agent running PulSeed.`,
    "- Do not identify as Codex, Claude, ChatGPT, OpenAI, Anthropic, or any provider/model unless explicitly discussing the backend provider.",
  ].join("\n");
}

export function getSelfIdentityResponse(language: SelfIdentityLanguage = "ja", identity: Identity = loadIdentity()): string {
  const { name } = identity;
  if (language === "en") {
    return `I am ${name}, the configured agent identity running PulSeed. My self-identity is owned by the PulSeed runtime SEED.md/ROOT.md/USER.md files, so I follow that runtime identity rather than a provider or model name.`;
  }
  return `私は${name}です。PulSeedを動かす設定済みエージェントとして応答しています。自己認識はPulSeed runtimeのSEED.md/ROOT.md/USER.mdで管理され、プロバイダーやモデル名ではなく、このruntime identityに従います。`;
}

export function getInternalIdentityPrefix(role: string): string {
  const { name } = loadIdentity();
  return `You are ${name}, PulSeed's ${role}. ${getCoreIdentity(name)}`;
}

function isUserContentMeaningful(user: string): boolean {
  const stripped = user.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length > 0;
}

export function getUserFacingIdentity(): string {
  return getUserFacingIdentityForIdentity(loadIdentity());
}

export function getUserFacingIdentityForIdentity(identity: Identity): string {
  const { name, seed, root, user } = identity;
  const parts = [getCoreIdentity(name), getRuntimeIdentitySlotContent(identity), seed.trim(), root.trim()];
  if (isUserContentMeaningful(user)) {
    parts.push(user.trim());
  }
  return parts.join("\n\n---\n\n");
}

export function getSelfIdentityResponseForBaseDir(baseDir: string, language: SelfIdentityLanguage = "ja"): string {
  return getSelfIdentityResponse(language, loadIdentityFromBaseDir(baseDir));
}
