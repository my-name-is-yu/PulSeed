import type { RankedCandidate, SearchSessionState } from "./contracts.js";

const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface StoredCodeSearchSession {
  session: SearchSessionState;
  cwd: string;
  expiresAt: number;
}

const sessions = new Map<string, StoredCodeSearchSession>();

function pruneSessions(): void {
  const now = Date.now();
  for (const [queryId, stored] of sessions) {
    if (stored.expiresAt <= now) sessions.delete(queryId);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (!oldest) break;
    sessions.delete(oldest);
  }
}

export function saveCodeSearchSession(session: SearchSessionState, cwd: string): void {
  pruneSessions();
  sessions.set(session.queryId, {
    session,
    cwd,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
}

export function getCodeSearchSession(queryId: string): StoredCodeSearchSession | null {
  pruneSessions();
  return sessions.get(queryId) ?? null;
}

export function resolveCodeSearchCandidates(queryId: string, candidateIds?: string[]): RankedCandidate[] {
  const stored = getCodeSearchSession(queryId);
  if (!stored) return [];
  if (!candidateIds || candidateIds.length === 0) return stored.session.candidates;
  const wanted = new Set(candidateIds);
  return stored.session.candidates.filter((candidate) => wanted.has(candidate.id));
}

export function clearCodeSearchSessionsForTests(): void {
  sessions.clear();
}
