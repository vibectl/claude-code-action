import { describe, it, expect } from "bun:test";
import {
  sanitizeMessage,
  getErrorMessage,
} from "../../src/vibectl-action/errors.ts";

describe("sanitizeMessage", () => {
  it("redacts Bearer tokens", () => {
    const result = sanitizeMessage(
      "Failed with Bearer vibe_secret123 in header",
    );
    expect(result).not.toContain("vibe_secret123");
    expect(result).toContain("***");
  });

  it("redacts vibe_ prefixed API keys", () => {
    const result = sanitizeMessage("Key: vibe_abc123xyz");
    expect(result).not.toContain("vibe_abc123xyz");
  });

  it("redacts GitHub server tokens (ghs_)", () => {
    const result = sanitizeMessage("Token: ghs_fakeTokenValue123");
    expect(result).not.toContain("ghs_fakeTokenValue123");
  });

  it("redacts GitHub personal access tokens (ghp_)", () => {
    const result = sanitizeMessage("Token: ghp_personalAccessToken");
    expect(result).not.toContain("ghp_personalAccessToken");
  });

  it("redacts GitHub fine-grained PATs (github_pat_)", () => {
    const result = sanitizeMessage("PAT: github_pat_11AAAA_xxxxx");
    expect(result).not.toContain("github_pat_11AAAA_xxxxx");
  });

  it("redacts Anthropic API keys (sk-)", () => {
    const result = sanitizeMessage(
      "Key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz",
    );
    expect(result).not.toContain("sk-ant-api03");
  });

  it("redacts Authorization headers", () => {
    const result = sanitizeMessage("Authorization: Bearer secret-token-here");
    expect(result).not.toContain("secret-token-here");
  });

  it("preserves non-sensitive content", () => {
    const result = sanitizeMessage("Task completed successfully in 5000ms");
    expect(result).toBe("Task completed successfully in 5000ms");
  });

  it("handles multiple sensitive patterns in one message", () => {
    const result = sanitizeMessage(
      "Error: Bearer vibe_key123 with ghs_token456",
    );
    expect(result).not.toContain("vibe_key123");
    expect(result).not.toContain("ghs_token456");
  });

  it("handles empty string", () => {
    expect(sanitizeMessage("")).toBe("");
  });
});

describe("getErrorMessage", () => {
  it("extracts message from Error objects", () => {
    const result = getErrorMessage(new Error("Something failed"));
    expect(result).toBe("Something failed");
  });

  it("converts non-Error values to strings", () => {
    const result = getErrorMessage("raw string error");
    expect(result).toBe("raw string error");
  });

  it("sanitizes Error messages containing secrets", () => {
    const err = new Error("Request failed with Bearer vibe_mysecret");
    const result = getErrorMessage(err);
    expect(result).not.toContain("vibe_mysecret");
  });

  it("handles null/undefined", () => {
    expect(getErrorMessage(null)).toBe("null");
    expect(getErrorMessage(undefined)).toBe("undefined");
  });
});
