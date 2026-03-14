#!/usr/bin/env bun
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  installFetchInterceptor,
  removeFetchInterceptor,
} from "../../src/vibectl/fetch-interceptor.ts";

/**
 * Tests for fetch interceptor — injects X-Proxy-Token and X-Egress-Mode
 * headers on requests matching the configured GitHub API URL.
 *
 * Security invariant: non-matching URLs MUST NOT receive proxy headers.
 * The proxy token is a per-task credential that must not leak to arbitrary hosts.
 */

describe("fetch-interceptor", () => {
  let originalFetch: typeof globalThis.fetch;

  // Track calls to the real fetch
  let fetchCalls: Array<{ url: string; init?: RequestInit }> = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = [];

    // Install a recording fetch that never makes real network calls
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof globalThis.fetch;
  });

  afterEach(() => {
    removeFetchInterceptor();
    globalThis.fetch = originalFetch;
  });

  describe("installFetchInterceptor", () => {
    test("injects X-Proxy-Token header on matching URL", async () => {
      const proxyUrl = "https://github-proxy.vibectl.dev";
      installFetchInterceptor({
        githubApiUrl: proxyUrl,
        proxyToken: "1234567890:base64sig",
        egressMode: "full",
      });

      await globalThis.fetch(`${proxyUrl}/repos/owner/repo/pulls`);

      expect(fetchCalls).toHaveLength(1);
      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Proxy-Token")).toBe("1234567890:base64sig");
    });

    test("injects X-Egress-Mode header on matching URL", async () => {
      const proxyUrl = "https://github-proxy.vibectl.dev";
      installFetchInterceptor({
        githubApiUrl: proxyUrl,
        proxyToken: "token123",
        egressMode: "relay",
      });

      await globalThis.fetch(`${proxyUrl}/repos/owner/repo/issues`);

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Egress-Mode")).toBe("relay");
    });

    test("does NOT inject headers on non-matching URL", async () => {
      installFetchInterceptor({
        githubApiUrl: "https://github-proxy.vibectl.dev",
        proxyToken: "secret-token",
        egressMode: "full",
      });

      await globalThis.fetch("https://api.github.com/repos/owner/repo");

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Proxy-Token")).toBeNull();
      expect(headers.get("X-Egress-Mode")).toBeNull();
    });

    test("preserves existing headers on matching URL", async () => {
      installFetchInterceptor({
        githubApiUrl: "https://proxy.test",
        proxyToken: "tok",
        egressMode: "full",
      });

      await globalThis.fetch("https://proxy.test/repos/test", {
        headers: {
          Authorization: "Bearer ghs_install_token",
          Accept: "application/vnd.github+json",
        },
      });

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer ghs_install_token");
      expect(headers.get("Accept")).toBe("application/vnd.github+json");
      expect(headers.get("X-Proxy-Token")).toBe("tok");
    });

    test("preserves existing headers on non-matching URL", async () => {
      installFetchInterceptor({
        githubApiUrl: "https://proxy.test",
        proxyToken: "tok",
        egressMode: "full",
      });

      await globalThis.fetch("https://other.service.com/api", {
        headers: { Authorization: "Bearer other-token" },
      });

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer other-token");
      expect(headers.get("X-Proxy-Token")).toBeNull();
    });

    test("handles Request object input (not just string URL)", async () => {
      const proxyUrl = "https://github-proxy.vibectl.dev";
      installFetchInterceptor({
        githubApiUrl: proxyUrl,
        proxyToken: "req-token",
        egressMode: "full",
      });

      const request = new Request(`${proxyUrl}/repos/owner/repo`);
      await globalThis.fetch(request);

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Proxy-Token")).toBe("req-token");
    });

    test("handles URL object input", async () => {
      const proxyUrl = "https://github-proxy.vibectl.dev";
      installFetchInterceptor({
        githubApiUrl: proxyUrl,
        proxyToken: "url-token",
        egressMode: "relay",
      });

      await globalThis.fetch(new URL(`${proxyUrl}/repos/owner/repo`));

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Proxy-Token")).toBe("url-token");
      expect(headers.get("X-Egress-Mode")).toBe("relay");
    });

    test("matches URL prefix, not exact match", async () => {
      const proxyUrl = "https://proxy.test/github";
      installFetchInterceptor({
        githubApiUrl: proxyUrl,
        proxyToken: "prefix-token",
        egressMode: "full",
      });

      // Should match: URL starts with proxyUrl
      await globalThis.fetch(`${proxyUrl}/repos/owner/repo/pulls/1`);
      expect(
        new Headers(fetchCalls[0]!.init?.headers).get("X-Proxy-Token"),
      ).toBe("prefix-token");

      // Should NOT match: different path
      await globalThis.fetch("https://proxy.test/other/path");
      expect(
        new Headers(fetchCalls[1]!.init?.headers).get("X-Proxy-Token"),
      ).toBeNull();
    });

    test("defaults egressMode to 'full' when not specified", async () => {
      installFetchInterceptor({
        githubApiUrl: "https://proxy.test",
        proxyToken: "tok",
      });

      await globalThis.fetch("https://proxy.test/repos/test");

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Egress-Mode")).toBe("full");
    });
  });

  describe("removeFetchInterceptor", () => {
    test("restores original fetch behavior", async () => {
      const beforeFetch = globalThis.fetch;
      installFetchInterceptor({
        githubApiUrl: "https://proxy.test",
        proxyToken: "tok",
        egressMode: "full",
      });

      // fetch should be replaced
      expect(globalThis.fetch).not.toBe(beforeFetch);

      removeFetchInterceptor();

      // fetch should be restored
      expect(globalThis.fetch).toBe(beforeFetch);
    });

    test("is safe to call multiple times", () => {
      installFetchInterceptor({
        githubApiUrl: "https://proxy.test",
        proxyToken: "tok",
        egressMode: "full",
      });

      removeFetchInterceptor();
      removeFetchInterceptor(); // should not throw
    });
  });

  describe("security: proxy token isolation", () => {
    test("proxy token does NOT leak to non-proxy hosts", async () => {
      installFetchInterceptor({
        githubApiUrl: "https://github-proxy.vibectl.dev",
        proxyToken: "sensitive-hmac-token",
        egressMode: "full",
      });

      // Attacker-controlled URL
      await globalThis.fetch("https://attacker.com/steal?callback=x");

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Proxy-Token")).toBeNull();
      expect(headers.get("X-Egress-Mode")).toBeNull();
    });

    test("proxy token does NOT leak to similar-looking URLs", async () => {
      installFetchInterceptor({
        githubApiUrl: "https://github-proxy.vibectl.dev",
        proxyToken: "sensitive-hmac-token",
        egressMode: "full",
      });

      // Similar prefix but different domain
      await globalThis.fetch("https://github-proxy.vibectl.dev.evil.com/repos");

      const headers = new Headers(fetchCalls[0]!.init?.headers);
      expect(headers.get("X-Proxy-Token")).toBeNull();
    });
  });
});
