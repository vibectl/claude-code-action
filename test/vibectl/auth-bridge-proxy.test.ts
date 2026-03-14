#!/usr/bin/env bun
// @ts-nocheck — test file uses flexible mock assertions
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { configureAuth } from "../../src/vibectl/auth-bridge.ts";
import type { TaskCredentials } from "../../src/vibectl/auth-bridge.ts";

/**
 * Tests for auth-bridge GitHub proxy extensions.
 *
 * Verifies GITHUB_API_URL configuration and fetch interceptor installation
 * when proxy credentials are provided in TaskCredentials.
 */

// Mock fetch interceptor to verify it gets called correctly
const mockInstall = mock(() => {});
const mockRemove = mock(() => {});
mock.module("../../src/vibectl/fetch-interceptor.ts", () => ({
  installFetchInterceptor: mockInstall,
  removeFetchInterceptor: mockRemove,
}));

describe("auth-bridge proxy extensions", () => {
  let originalEnv: typeof process.env;

  const baseCredentials: TaskCredentials = {
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
    mockInstall.mockClear();
    mockRemove.mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("GITHUB_API_URL configuration", () => {
    test("sets GITHUB_API_URL when githubApiUrl is provided", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://github-proxy.vibectl.dev/v1/github/cust_123/inst_456",
      });
      expect(process.env.GITHUB_API_URL).toBe(
        "https://github-proxy.vibectl.dev/v1/github/cust_123/inst_456",
      );
    });

    test("does NOT set GITHUB_API_URL when githubApiUrl is absent", async () => {
      delete process.env.GITHUB_API_URL;
      await configureAuth(baseCredentials);
      expect(process.env.GITHUB_API_URL).toBeUndefined();
    });
  });

  describe("fetch interceptor installation", () => {
    test("installs fetch interceptor when githubProxyToken is provided", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://proxy.test",
        githubProxyToken: "1234:sig",
        egressMode: "full",
      });

      expect(mockInstall).toHaveBeenCalledTimes(1);
      expect(mockInstall).toHaveBeenCalledWith({
        githubApiUrl: "https://proxy.test",
        proxyToken: "1234:sig",
        egressMode: "full",
      });
    });

    test("does NOT install fetch interceptor when githubProxyToken is absent", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://proxy.test",
      });

      expect(mockInstall).not.toHaveBeenCalled();
    });

    test("passes egressMode to fetch interceptor", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://proxy.test",
        githubProxyToken: "token",
        egressMode: "relay",
      });

      expect(mockInstall).toHaveBeenCalledWith(
        expect.objectContaining({ egressMode: "relay" }),
      );
    });

    test("defaults egressMode when not specified", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://proxy.test",
        githubProxyToken: "token",
      });

      expect(mockInstall).toHaveBeenCalledWith(
        expect.objectContaining({ egressMode: "full" }),
      );
    });
  });

  describe("existing functionality preserved", () => {
    test("still sets GITHUB_TOKEN", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://proxy.test",
        githubProxyToken: "token",
      });
      expect(process.env.GITHUB_TOKEN).toBe(baseCredentials.githubToken);
    });

    test("still sets ANTHROPIC_BASE_URL", async () => {
      await configureAuth({
        ...baseCredentials,
        githubApiUrl: "https://proxy.test",
        githubProxyToken: "token",
      });
      expect(process.env.ANTHROPIC_BASE_URL).toBe(baseCredentials.aiProxyUrl);
    });
  });
});
