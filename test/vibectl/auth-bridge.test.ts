#!/usr/bin/env bun
// @ts-nocheck — test file uses flexible mock assertions
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { configureAuth, configurePromptOnlyAuth } from "../../src/vibectl/auth-bridge.ts";
import type { TaskCredentials } from "../../src/vibectl/auth-bridge.ts";

describe("auth-bridge", () => {
  let originalEnv: typeof process.env;

  const testCredentials: TaskCredentials = {
    githubToken: "ghs_testtoken1234567890abcdefghijklmnop",
    aiProxyUrl: "https://ai-proxy.vibectl.dev/v1/proxy/cust_123",
    proxyHeaders: { "X-Proxy-Token": "hmac-signed-token-value" },
    repoOwner: "test-owner",
    repoName: "test-repo",
    eventName: "issue_comment",
    botUserId: "999999",
    botLogin: "vibectl[bot]",
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("configureAuth", () => {
    test("sets GITHUB_TOKEN and GH_TOKEN", async () => {
      await configureAuth(testCredentials);
      expect(process.env.GITHUB_TOKEN).toBe(testCredentials.githubToken);
      expect(process.env.GH_TOKEN).toBe(testCredentials.githubToken);
    });

    test("sets ANTHROPIC_BASE_URL to AI proxy", async () => {
      await configureAuth(testCredentials);
      expect(process.env.ANTHROPIC_BASE_URL).toBe(testCredentials.aiProxyUrl);
    });

    test("sets ANTHROPIC_API_KEY to dummy value", async () => {
      await configureAuth(testCredentials);
      expect(process.env.ANTHROPIC_API_KEY).toBe(
        "dummy-key-replaced-by-ai-proxy",
      );
    });

    test("sets ANTHROPIC_CUSTOM_HEADERS in Name: Value format", async () => {
      await configureAuth(testCredentials);
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        "X-Proxy-Token: hmac-signed-token-value",
      );
    });

    test("sets bot identity env vars", async () => {
      await configureAuth(testCredentials);
      expect(process.env.BOT_USER_ID).toBe("999999");
      expect(process.env.BOT_LOGIN).toBe("vibectl[bot]");
    });

    test("sets GITHUB_ACTION_PATH to default /opt/cca", async () => {
      await configureAuth(testCredentials);
      expect(process.env.GITHUB_ACTION_PATH).toBe("/opt/cca");
    });

    test("sets GITHUB_ACTION_PATH to custom path", async () => {
      await configureAuth({
        ...testCredentials,
        ccaSourcePath: "/custom/cca/path",
      });
      expect(process.env.GITHUB_ACTION_PATH).toBe("/custom/cca/path");
    });

    test("sets GITHUB_EVENT_NAME", async () => {
      await configureAuth(testCredentials);
      expect(process.env.GITHUB_EVENT_NAME).toBe("issue_comment");
    });

    test("sets DEFAULT_WORKFLOW_TOKEN to installation token", async () => {
      await configureAuth(testCredentials);
      expect(process.env.DEFAULT_WORKFLOW_TOKEN).toBe(
        testCredentials.githubToken,
      );
    });

    test("creates temp directory and returns its path", async () => {
      const { tempDir } = await configureAuth(testCredentials);
      expect(tempDir).toBeTruthy();
      expect(existsSync(tempDir)).toBe(true);
    });

    test("sets RUNNER_TEMP to created temp directory", async () => {
      const { tempDir } = await configureAuth(testCredentials);
      expect(process.env.RUNNER_TEMP).toBe(tempDir);
    });

    test("creates GITHUB_OUTPUT file", async () => {
      const { tempDir } = await configureAuth(testCredentials);
      const outputFile = process.env.GITHUB_OUTPUT!;
      expect(outputFile).toBe(`${tempDir}/github-output`);
      expect(existsSync(outputFile)).toBe(true);
      expect(readFileSync(outputFile, "utf-8")).toBe("");
    });

    test("creates GITHUB_ENV file", async () => {
      const { tempDir } = await configureAuth(testCredentials);
      const envFile = process.env.GITHUB_ENV!;
      expect(envFile).toBe(`${tempDir}/github-env`);
      expect(existsSync(envFile)).toBe(true);
    });

    test("sets GITHUB_SERVER_URL default", async () => {
      delete process.env.GITHUB_SERVER_URL;
      await configureAuth(testCredentials);
      expect(process.env.GITHUB_SERVER_URL).toBe("https://github.com");
    });

    test("preserves existing GITHUB_SERVER_URL", async () => {
      process.env.GITHUB_SERVER_URL = "https://github.example.com";
      await configureAuth(testCredentials);
      expect(process.env.GITHUB_SERVER_URL).toBe("https://github.example.com");
    });

    test("formats multiple proxy headers with newline separation", async () => {
      await configureAuth({
        ...testCredentials,
        proxyHeaders: {
          "X-Proxy-Token": "token-value",
          "X-Egress-Mode": "full",
        },
      });
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        "X-Proxy-Token: token-value\nX-Egress-Mode: full",
      );
    });

    test("ANTHROPIC_CUSTOM_HEADERS is not JSON format", async () => {
      await configureAuth(testCredentials);
      const value = process.env.ANTHROPIC_CUSTOM_HEADERS!;
      expect(() => JSON.parse(value)).toThrow();
      expect(value).not.toContain("{");
      expect(value).not.toContain("}");
    });

    test("does not set ANTHROPIC_CUSTOM_HEADERS when no proxy headers", async () => {
      delete process.env.ANTHROPIC_CUSTOM_HEADERS;
      await configureAuth({
        ...testCredentials,
        proxyHeaders: {},
      });
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    });

    test("sets GITHUB_WORKSPACE default", async () => {
      delete process.env.GITHUB_WORKSPACE;
      await configureAuth(testCredentials);
      expect(process.env.GITHUB_WORKSPACE).toBe("/workspace");
    });
  });

  describe("configurePromptOnlyAuth", () => {
    const promptOnlyCredentials = {
      aiProxyUrl: "https://ai-proxy.vibectl.dev/v1/proxy/cust_456",
      proxyHeaders: { "X-Proxy-Token": "prompt-only-hmac" },
    };

    test("sets ANTHROPIC_BASE_URL to AI proxy", async () => {
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.ANTHROPIC_BASE_URL).toBe(
        promptOnlyCredentials.aiProxyUrl,
      );
    });

    test("sets ANTHROPIC_API_KEY to dummy value", async () => {
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.ANTHROPIC_API_KEY).toBe(
        "dummy-key-replaced-by-ai-proxy",
      );
    });

    test("sets ANTHROPIC_CUSTOM_HEADERS from proxy headers", async () => {
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
        "X-Proxy-Token: prompt-only-hmac",
      );
    });

    test("does not set GITHUB_TOKEN", async () => {
      delete process.env.GITHUB_TOKEN;
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.GITHUB_TOKEN).toBeUndefined();
    });

    test("does not set GH_TOKEN", async () => {
      delete process.env.GH_TOKEN;
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.GH_TOKEN).toBeUndefined();
    });

    test("does not set BOT_USER_ID", async () => {
      delete process.env.BOT_USER_ID;
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.BOT_USER_ID).toBeUndefined();
    });

    test("does not set BOT_LOGIN", async () => {
      delete process.env.BOT_LOGIN;
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.BOT_LOGIN).toBeUndefined();
    });

    test("does not set GITHUB_EVENT_NAME", async () => {
      delete process.env.GITHUB_EVENT_NAME;
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.GITHUB_EVENT_NAME).toBeUndefined();
    });

    test("creates temp directory and returns its path", async () => {
      const { tempDir } = await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(tempDir).toBeTruthy();
      expect(existsSync(tempDir)).toBe(true);
    });

    test("sets RUNNER_TEMP to created temp directory", async () => {
      const { tempDir } = await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.RUNNER_TEMP).toBe(tempDir);
    });

    test("creates GITHUB_OUTPUT file", async () => {
      const { tempDir } = await configurePromptOnlyAuth(promptOnlyCredentials);
      const outputFile = process.env.GITHUB_OUTPUT!;
      expect(outputFile).toBe(`${tempDir}/github-output`);
      expect(existsSync(outputFile)).toBe(true);
    });

    test("creates GITHUB_ENV file", async () => {
      const { tempDir } = await configurePromptOnlyAuth(promptOnlyCredentials);
      const envFile = process.env.GITHUB_ENV!;
      expect(envFile).toBe(`${tempDir}/github-env`);
      expect(existsSync(envFile)).toBe(true);
    });

    test("sets GITHUB_ACTION_PATH to default /opt/cca", async () => {
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.GITHUB_ACTION_PATH).toBe("/opt/cca");
    });

    test("sets GITHUB_ACTION_PATH to custom path", async () => {
      await configurePromptOnlyAuth({
        ...promptOnlyCredentials,
        ccaSourcePath: "/custom/path",
      });
      expect(process.env.GITHUB_ACTION_PATH).toBe("/custom/path");
    });

    test("sets GITHUB_WORKSPACE default", async () => {
      delete process.env.GITHUB_WORKSPACE;
      await configurePromptOnlyAuth(promptOnlyCredentials);
      expect(process.env.GITHUB_WORKSPACE).toBe("/workspace");
    });
  });
});
