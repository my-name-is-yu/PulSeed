import { describe, expect, it, vi } from "vitest";
import type { DurableLoop, LoopResult } from "../../../orchestrator/loop/durable-loop.js";
import { formatProgressGap, runLoopWithSignals } from "../utils/loop-runner.js";

describe("loop-runner progress formatting", () => {
  it("does not round a non-zero residual gap to 0.00", () => {
    expect(formatProgressGap(0)).toBe("0.00");
    expect(formatProgressGap(0.004)).toBe("<0.01");
    expect(formatProgressGap(0.012)).toBe("0.01");
  });
});

describe("runLoopWithSignals", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "aborts active DurableLoop work on %s",
    async (signalName) => {
      const beforeSigintListeners = process.listenerCount("SIGINT");
      const beforeSigtermListeners = process.listenerCount("SIGTERM");
      const stop = vi.fn();
      let capturedSignal: AbortSignal | undefined;
      const run = vi.fn((_goalId: string, options?: { abortSignal?: AbortSignal }) => {
        capturedSignal = options?.abortSignal;
        return new Promise<LoopResult>((resolve) => {
          options?.abortSignal?.addEventListener(
            "abort",
            () => resolve({ finalStatus: "stopped" } as LoopResult),
            { once: true },
          );
        });
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const durableLoop = { run, stop } as unknown as DurableLoop;

      try {
        const resultPromise = runLoopWithSignals(durableLoop, "goal-active-native-work");
        await vi.waitFor(() => expect(capturedSignal).toBeDefined());

        process.emit(signalName);
        const result = await resultPromise;

        expect(result).toEqual({ finalStatus: "stopped" });
        expect(run).toHaveBeenCalledWith("goal-active-native-work", { abortSignal: capturedSignal });
        expect(stop).toHaveBeenCalledTimes(1);
        expect(capturedSignal?.aborted).toBe(true);
        expect(process.listenerCount("SIGINT")).toBe(beforeSigintListeners);
        expect(process.listenerCount("SIGTERM")).toBe(beforeSigtermListeners);
      } finally {
        logSpy.mockRestore();
      }
    },
  );
});
