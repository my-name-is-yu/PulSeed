import {
  ARC_AGI3_DEFAULT_BASE_URL,
  ArcAgi3GameSchema,
  ArcAgi3OpenScorecardResponseSchema,
  ArcAgi3ScorecardSchema,
  ArcAgi3SnapshotSchema,
  type ArcAgi3ActionName,
  type ArcAgi3Game,
  type ArcAgi3OpenScorecardResponse,
  type ArcAgi3Scorecard,
  type ArcAgi3Snapshot,
} from "./types.js";

type FetchLike = typeof fetch;

export interface ArcAgi3RestClientOptions {
  baseUrl?: string;
  apiKey?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
}

export interface ArcAgi3RestClient {
  listGames(signal?: AbortSignal): Promise<ArcAgi3Game[]>;
  openScorecard(input: {
    source_url?: string;
    tags?: string[];
    opaque?: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<ArcAgi3OpenScorecardResponse>;
  reset(input: { game_id: string; card_id: string; guid?: string | null }, signal?: AbortSignal): Promise<ArcAgi3Snapshot>;
  action(input: {
    action: Exclude<ArcAgi3ActionName, "RESET">;
    game_id: string;
    guid: string;
    x?: number;
    y?: number;
    reasoning?: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<ArcAgi3Snapshot>;
  retrieveScorecard(cardId: string, signal?: AbortSignal): Promise<ArcAgi3Scorecard>;
  retrieveScorecardForGame(cardId: string, gameId: string, signal?: AbortSignal): Promise<ArcAgi3Scorecard>;
  closeScorecard(cardId: string, signal?: AbortSignal): Promise<ArcAgi3Scorecard>;
}

export class ArcAgi3HttpClient implements ArcAgi3RestClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly cookieJar = new ArcAgi3CookieJar();

  constructor(options: ArcAgi3RestClientOptions = {}) {
    const env = options.env ?? process.env;
    this.baseUrl = stripTrailingSlash(options.baseUrl ?? env["ARC_AGI3_BASE_URL"] ?? ARC_AGI3_DEFAULT_BASE_URL);
    this.apiKey = options.apiKey
      ?? env["ARC_API_KEY"]
      ?? env["ARC_AGI_API"]
      ?? env["ARC_AGI_API_KEY"]
      ?? "";
    this.fetchImpl = options.fetchImpl ?? fetch;
    if (!this.apiKey.trim()) {
      throw new Error("ARC-AGI-3 API key is required via ARC_API_KEY.");
    }
  }

  async listGames(signal?: AbortSignal): Promise<ArcAgi3Game[]> {
    const payload = await this.request("GET", "/api/games", undefined, signal);
    return ArcAgi3GameSchema.array().parse(payload);
  }

  async openScorecard(input: {
    source_url?: string;
    tags?: string[];
    opaque?: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<ArcAgi3OpenScorecardResponse> {
    return ArcAgi3OpenScorecardResponseSchema.parse(
      await this.request("POST", "/api/scorecard/open", input, signal),
    );
  }

  async reset(
    input: { game_id: string; card_id: string; guid?: string | null },
    signal?: AbortSignal,
  ): Promise<ArcAgi3Snapshot> {
    return ArcAgi3SnapshotSchema.parse(await this.request("POST", "/api/cmd/RESET", input, signal));
  }

  async action(input: {
    action: Exclude<ArcAgi3ActionName, "RESET">;
    game_id: string;
    guid: string;
    x?: number;
    y?: number;
    reasoning?: Record<string, unknown>;
  }, signal?: AbortSignal): Promise<ArcAgi3Snapshot> {
    const body: Record<string, unknown> = {
      game_id: input.game_id,
      guid: input.guid,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
    };
    if (input.action === "ACTION6") {
      body["x"] = input.x;
      body["y"] = input.y;
    }
    return ArcAgi3SnapshotSchema.parse(await this.request("POST", `/api/cmd/${input.action}`, body, signal));
  }

  async retrieveScorecard(cardId: string, signal?: AbortSignal): Promise<ArcAgi3Scorecard> {
    return ArcAgi3ScorecardSchema.parse(await this.request("GET", `/api/scorecard/${encodeURIComponent(cardId)}`, undefined, signal));
  }

  async retrieveScorecardForGame(cardId: string, gameId: string, signal?: AbortSignal): Promise<ArcAgi3Scorecard> {
    return ArcAgi3ScorecardSchema.parse(
      await this.request("GET", `/api/scorecard/${encodeURIComponent(cardId)}/${encodeURIComponent(gameId)}`, undefined, signal),
    );
  }

  async closeScorecard(cardId: string, signal?: AbortSignal): Promise<ArcAgi3Scorecard> {
    return ArcAgi3ScorecardSchema.parse(
      await this.request("POST", "/api/scorecard/close", { card_id: cardId }, signal),
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...this.cookieJar.header(),
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    this.cookieJar.capture(response.headers);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`ARC-AGI-3 API ${method} ${path} failed (${response.status}): ${sanitizeApiError(text)}`);
    }
    return response.json();
  }
}

class ArcAgi3CookieJar {
  private readonly cookies = new Map<string, string>();

  capture(headers: Headers): void {
    for (const cookie of getSetCookieHeaders(headers)) {
      const pair = cookie.split(";")[0]?.trim();
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return {};
    return {
      Cookie: [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; "),
    };
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const direct = withGetSetCookie.getSetCookie?.();
  if (direct && direct.length > 0) return direct;
  const combined = headers.get("set-cookie");
  return combined ? splitSetCookieHeader(combined) : [];
}

function splitSetCookieHeader(value: string): string[] {
  return value.split(/,(?=\s*[^;,\s]+=)/g).map((part) => part.trim()).filter(Boolean);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sanitizeApiError(value: string): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.slice(0, 500) || "empty response";
}
