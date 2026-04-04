import boundaries from "eslint-plugin-boundaries";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    plugins: {
      boundaries,
    },
    settings: {
      "boundaries/elements": [
        {
          type: "base",
          pattern: "src/base/**",
        },
        {
          type: "platform",
          pattern: "src/platform/**",
        },
        {
          type: "orchestrator",
          pattern: "src/orchestrator/**",
        },
        {
          type: "interface",
          pattern: "src/interface/**",
        },
        {
          type: "shared",
          pattern: [
            "src/adapters/**",
            "src/prompt/**",
            "src/reflection/**",
            "src/reporting/**",
            "src/runtime/**",
          ],
        },
      ],
    },
    rules: {
      // Enforce layer hierarchy: no upward imports
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            // base: can only import from base
            {
              from: "base",
              allow: ["base"],
            },
            // platform: can import base + shared
            {
              from: "platform",
              allow: ["base", "shared"],
            },
            // orchestrator: can import base + platform + shared
            {
              from: "orchestrator",
              allow: ["base", "platform", "shared"],
            },
            // interface: can import base + platform + orchestrator + shared
            {
              from: "interface",
              allow: ["base", "platform", "orchestrator", "shared"],
            },
            // shared (cross-cutting): can import base + platform + orchestrator
            // but NOT interface (would create circular dependency)
            {
              from: "shared",
              allow: ["base", "platform", "orchestrator", "shared"],
            },
          ],
        },
      ],
      // Entry-point enforcement is off — we only care about layer boundaries
      "boundaries/entry-point": "off",
    },
  },
];

export default config;
