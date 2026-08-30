import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("config", () => {
  it("supports OpenAI as the selected model provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: path.join(root, "codex-home"),
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_MODEL: "gpt-5-codex",
    });

    expect(config.modelProvider).toBe("openai");
    expect(config.modelConfigured).toBe(true);
    expect(config.modelId).toBe("gpt-5-codex");

    await writeCodexConfig(config);
    const toml = await readFile(path.join(config.codexHome, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "agenttrace_openai_compatible"');
    expect(toml).toContain("[model_providers.agenttrace_openai_compatible]");
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
  });

  it("uses a custom provider alias for OpenAI-compatible base URLs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-config-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: path.join(root, "codex-home"),
      MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "openai-test-key",
      OPENAI_MODEL: "deepseek-v4-flash",
      OPENAI_BASE_URL: "https://api.deepseek.com",
    });

    await writeCodexConfig(config);
    const toml = await readFile(path.join(config.codexHome, "config.toml"), "utf8");
    expect(toml).toContain('model_provider = "agenttrace_openai_compatible"');
    expect(toml).toContain("[model_providers.agenttrace_openai_compatible]");
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
  });

  it("keeps Ark as the default model provider", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "ark-test-key",
      ARK_MODEL: "ep-test",
    });

    expect(config.modelProvider).toBe("ark");
    expect(config.modelConfigured).toBe(true);
    expect(config.modelId).toBe("ep-test");
  });
});
