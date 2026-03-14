#!/usr/bin/env bun
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { parsePayload } from "../../src/vibectl/main.ts";

/**
 * Tests for src/vibectl/main.ts — CLI entry point for container invocation.
 *
 * Tests parsePayload() which extracts and validates the task payload from
 * the VIBECTL_TASK_PAYLOAD environment variable. The auto-executing main
 * block (guarded by import.meta.main) is not tested here — it delegates
 * to parsePayload() and executeTask(), both tested independently.
 *
 * NOTE: Does NOT use mock.module() to avoid cross-file mock pollution
 * in bun's single-process test runner. The entry-adapter mock tests
 * live in test/vibectl/mocked/ which would be affected by mock.module
 * on entry-adapter.ts.
 */

describe("main CLI parsePayload", () => {
  let originalEnv: typeof process.env;

  const validPayload = {
    credentials: {
      githubToken: "ghs_test",
      aiProxyUrl: "https://proxy.test",
      proxyHeaders: {},
      repoOwner: "owner",
      repoName: "repo",
      eventName: "issue_comment",
      botUserId: "123",
      botLogin: "bot",
    },
    contextJson: {
      eventName: "issue_comment",
      payload: {},
      repo: { owner: "owner", repo: "repo" },
      actor: "user",
    },
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("parses valid JSON payload from env var", () => {
    process.env.VIBECTL_TASK_PAYLOAD = JSON.stringify(validPayload);
    const result = parsePayload();

    // Should return parsed payload (not an error result)
    expect("credentials" in result).toBe(true);
    expect((result as any).credentials.githubToken).toBe("ghs_test");
    expect((result as any).contextJson.actor).toBe("user");
  });

  test("returns error result when VIBECTL_TASK_PAYLOAD is missing", () => {
    delete process.env.VIBECTL_TASK_PAYLOAD;
    const result = parsePayload();

    expect("success" in result).toBe(true);
    expect((result as any).success).toBe(false);
    expect((result as any).mode).toBe("agent");
    expect((result as any).error).toContain("VIBECTL_TASK_PAYLOAD");
  });

  test("returns error result when payload is invalid JSON", () => {
    process.env.VIBECTL_TASK_PAYLOAD = "not valid json {{{";
    const result = parsePayload();

    expect("success" in result).toBe(true);
    expect((result as any).success).toBe(false);
    expect((result as any).error).toContain("parse");
  });

  test("returns error result when payload is empty string", () => {
    process.env.VIBECTL_TASK_PAYLOAD = "";
    const result = parsePayload();

    // Empty string is falsy, treated as missing
    expect("success" in result).toBe(true);
    expect((result as any).success).toBe(false);
  });

  test("error results are JSON-serializable (no unhandled exceptions)", () => {
    delete process.env.VIBECTL_TASK_PAYLOAD;
    const result = parsePayload();

    // Verify round-trip through JSON
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);
    expect(deserialized.success).toBe(false);
    expect(deserialized.mode).toBe("agent");
    expect(typeof deserialized.error).toBe("string");
  });

  test("preserves all payload fields including optional ones", () => {
    const payloadWithOptionals = {
      ...validPayload,
      taskConfig: { trigger_phrase: "@vibectl" },
      prompt: "Review the code",
    };
    process.env.VIBECTL_TASK_PAYLOAD = JSON.stringify(payloadWithOptionals);
    const result = parsePayload();

    expect("credentials" in result).toBe(true);
    expect((result as any).taskConfig.trigger_phrase).toBe("@vibectl");
    expect((result as any).prompt).toBe("Review the code");
  });

  test("preserves proxy credential fields", () => {
    const payloadWithProxy = {
      ...validPayload,
      credentials: {
        ...validPayload.credentials,
        githubApiUrl: "https://github-proxy.vibectl.dev/v1/github/cust/inst",
        githubProxyToken: "1234567890:base64sig",
        egressMode: "relay",
      },
    };
    process.env.VIBECTL_TASK_PAYLOAD = JSON.stringify(payloadWithProxy);
    const result = parsePayload();

    expect("credentials" in result).toBe(true);
    expect((result as any).credentials.githubApiUrl).toBe(
      "https://github-proxy.vibectl.dev/v1/github/cust/inst",
    );
    expect((result as any).credentials.githubProxyToken).toBe("1234567890:base64sig");
    expect((result as any).credentials.egressMode).toBe("relay");
  });
});
