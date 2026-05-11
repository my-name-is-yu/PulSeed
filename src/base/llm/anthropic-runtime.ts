import { createRequire } from "node:module";
import type Anthropic from "@anthropic-ai/sdk";

const require = createRequire(import.meta.url);

export const AnthropicRuntime = require("@anthropic-ai/sdk") as typeof Anthropic;
