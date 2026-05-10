import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolCallContext } from "../../../types.js";
import { ConfigTool } from "../ConfigTool.js";

const tempDirs: string[] = [];

function makeContext(providerConfigBaseDir: string): ToolCallContext {
  return {
    cwd: providerConfigBaseDir,
    goalId: "test-goal",
    trustBalance: 0,
    preApproved: false,
    approvalFn: async () => false,
    providerConfigBaseDir,
  } as ToolCallContext;
}

async function makePulseedHome(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-config-tool-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe("ConfigTool", () => {
  it("reads provider config through the provider-config file boundary", async () => {
    const pulseedHome = await makePulseedHome();
    await fsp.writeFile(
      path.join(pulseedHome, "provider.json"),
      JSON.stringify({
        provider: "anthropic",
        model: "claude-3-5-sonnet-latest",
        adapter: "claude_api",
        api_key: "sk-secret",
      }),
      "utf-8",
    );

    const result = await new ConfigTool().call({}, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      provider: "anthropic",
      model: "claude-3-5-sonnet-latest",
      adapter: "claude_api",
      default_adapter: "claude_api",
      pulseed_home_dir: pulseedHome,
    });
    expect(result.data).not.toHaveProperty("api_key");
  });

  it("reports legacy provider adapter through the current adapter field", async () => {
    const pulseedHome = await makePulseedHome();
    await fsp.writeFile(
      path.join(pulseedHome, "provider.json"),
      JSON.stringify({
        llm_provider: "codex",
        default_adapter: "openai_codex_cli",
        codex: { model: "gpt-5.4-mini" },
      }),
      "utf-8",
    );

    const result = await new ConfigTool().call({ key: "default_adapter" }, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ key: "default_adapter", value: "openai_codex_cli" });
    expect(result.summary).toBe("Config default_adapter=openai_codex_cli");
  });

  it("does not parse oversized provider config through the tool path", async () => {
    const pulseedHome = await makePulseedHome();
    const oversizedModel = "x".repeat(1024 * 1024);
    await fsp.writeFile(
      path.join(pulseedHome, "provider.json"),
      JSON.stringify({
        provider: "openai",
        model: oversizedModel,
        adapter: "openai_api",
      }),
      "utf-8",
    );

    const result = await new ConfigTool().call({}, makeContext(pulseedHome));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      provider: "unknown",
      model: "unknown",
      adapter: "openai_codex_cli",
      default_adapter: "openai_codex_cli",
      pulseed_home_dir: pulseedHome,
    });
  });
});
