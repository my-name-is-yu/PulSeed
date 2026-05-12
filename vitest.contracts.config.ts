import { defineConfig } from "vitest/config";
import {
  contractInclude,
  sharedCoverage,
  sharedResolve,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: contractInclude,
    coverage: sharedCoverage,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: sharedResolve,
});
