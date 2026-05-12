import { defineConfig } from "vitest/config";
import {
  replayInclude,
  sharedCoverage,
  sharedResolve,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: replayInclude,
    coverage: sharedCoverage,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: sharedResolve,
});
