import type { Logger } from "../../../runtime/logger.js";

export type WorkspaceContextFetcher = (goalId: string, dimensionName: string) => Promise<string | undefined>;

export function createWorkspaceContextFetcher(
  contextProvider: ((goalId: string, dimensionName: string) => Promise<string>) | undefined,
  logger?: Logger,
): WorkspaceContextFetcher {
  const contextCache = new Map<string, string>();
  let warnedNoProvider = false;

  return async (goalId: string, dimensionName: string): Promise<string | undefined> => {
    const cacheKey = `${goalId}::${dimensionName}`;
    if (contextCache.has(cacheKey)) return contextCache.get(cacheKey);

    if (contextProvider) {
      try {
        const context = await contextProvider(goalId, dimensionName);
        contextCache.set(cacheKey, context);
        return context;
      } catch (err) {
        logger?.warn(
          `[ObservationEngine] contextProvider failed: ${err instanceof Error ? err.message : String(err)}. LLM observation will proceed without workspace context.`
        );
        return undefined;
      }
    }

    if (!warnedNoProvider) {
      warnedNoProvider = true;
      logger?.warn(
        `[ObservationEngine] No contextProvider configured. LLM observation will proceed without workspace context (scores may be unreliable).`
      );
    }

    return undefined;
  };
}
