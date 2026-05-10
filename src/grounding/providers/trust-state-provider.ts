import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";
import { TrustStateStore } from "../../runtime/store/trust-state-store.js";

export const trustStateProvider: GroundingProvider = {
  key: "trust_state",
  kind: "dynamic",
  async build(context) {
    const stateManager = context.deps.stateManager;
    if (!stateManager || typeof (stateManager as { getBaseDir?: unknown }).getBaseDir !== "function") {
      return null;
    }
    const store = await new TrustStateStore(stateManager.getBaseDir()).loadStore();
    const balances = store.balances;
    const entries = Object.entries(balances)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([domain, value]) => `- ${domain}: balance=${value.balance}`);

    return makeSection(
      "trust_state",
      entries.length > 0 ? entries.join("\n") : "No adapter trust state recorded.",
      [
        makeSource("trust_state", "sqlite://pulseed-control/trust-state/current", {
          type: entries.length > 0 ? "state" : "none",
          trusted: true,
          accepted: true,
          retrievalId: entries.length > 0 ? "trust:all" : "none:trust_state",
        }),
      ],
    );
  },
};
