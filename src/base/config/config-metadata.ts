// Re-export from tool-metadata for backward compatibility.
// New code should import from tool-metadata.ts directly.
export {
  CONFIG_METADATA,
  buildConfigKeyDescription,
  buildConfigToolDescription,
  configChangeRequiresApproval,
  MUTATION_TOOL_METADATA,
  buildMutationToolDescription,
} from "./tool-metadata.js";
export type {
  ConfigKeyMeta,
  MutationToolMeta,
} from "./tool-metadata.js";
