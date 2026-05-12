export interface NetworkGuardHandle {
  restore(): void;
}

export function installNoNetworkGuard(): NetworkGuardHandle {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network access is disabled in PulSeed trace harness by default.");
  };
  return {
    restore(): void {
      globalThis.fetch = originalFetch;
    },
  };
}
