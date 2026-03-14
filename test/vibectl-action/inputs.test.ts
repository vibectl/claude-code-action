import { describe, it, expect, beforeEach, mock } from "bun:test";
import { parseEnvInput, getInputs } from "../../src/vibectl-action/inputs.ts";

// Mock @actions/core
const mockGetInput = mock(() => "");
const mockSetSecret = mock(() => {});
mock.module("@actions/core", () => ({
  getInput: mockGetInput,
  setSecret: mockSetSecret,
  info: mock(() => {}),
  debug: mock(() => {}),
  warning: mock(() => {}),
  error: mock(() => {}),
  setOutput: mock(() => {}),
  setFailed: mock(() => {}),
}));

describe("parseEnvInput", () => {
  it("parses KEY=VALUE lines into a record", () => {
    const result = parseEnvInput("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("returns empty object for empty string", () => {
    expect(parseEnvInput("")).toEqual({});
  });

  it("returns empty object for whitespace-only string", () => {
    expect(parseEnvInput("  \n  ")).toEqual({});
  });

  it("handles values containing equals signs", () => {
    const result = parseEnvInput("DSN=postgres://user:pass@host/db?opt=val");
    expect(result).toEqual({ DSN: "postgres://user:pass@host/db?opt=val" });
  });

  it("skips blank lines", () => {
    const result = parseEnvInput("FOO=bar\n\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips comment lines starting with #", () => {
    const result = parseEnvInput("# This is a comment\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("skips lines without equals sign", () => {
    const result = parseEnvInput("INVALID_LINE\nVALID=value");
    expect(result).toEqual({ VALID: "value" });
  });

  it("handles empty values", () => {
    const result = parseEnvInput("EMPTY_VAL=");
    expect(result).toEqual({ EMPTY_VAL: "" });
  });

  it("preserves whitespace in values", () => {
    const result = parseEnvInput("MSG=hello world");
    expect(result).toEqual({ MSG: "hello world" });
  });

  it("trims leading/trailing whitespace from lines", () => {
    const result = parseEnvInput("  FOO=bar  \n  BAZ=qux  ");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("getInputs", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockGetInput.mockReset();
    mockSetSecret.mockReset();
    process.env = { ...originalEnv };
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;
  });

  function setupInputs(inputs: Record<string, string>) {
    mockGetInput.mockImplementation(
      ((name: string) => inputs[name] || "") as () => string,
    );
  }

  it("parses required inputs correctly", () => {
    setupInputs({
      "api-key": "vibe_test123",
      prompt: "review this code",
    });

    const result = getInputs();

    expect(result.apiKey).toBe("vibe_test123");
    expect(result.prompt).toBe("review this code");
    expect(result.apiUrl).toBe("https://api.vibectl.dev");
    expect(result.timeoutSeconds).toBe(1800);
  });

  it("masks the API key immediately", () => {
    setupInputs({
      "api-key": "vibe_secret",
      prompt: "test",
    });

    getInputs();

    expect(mockSetSecret).toHaveBeenCalledWith("vibe_secret");
  });

  it("masks GitHub token when present", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
    });
    process.env.GITHUB_TOKEN = "ghs_faketoken";

    getInputs();

    expect(mockSetSecret).toHaveBeenCalledWith("ghs_faketoken");
  });

  it("uses custom API URL when provided", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "api-url": "https://custom.api.dev",
    });

    const result = getInputs();
    expect(result.apiUrl).toBe("https://custom.api.dev");
  });

  it("parses custom timeout", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      timeout: "300",
    });

    const result = getInputs();
    expect(result.timeoutSeconds).toBe(300);
  });

  it("throws on invalid timeout", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      timeout: "not-a-number",
    });

    expect(() => getInputs()).toThrow("Invalid timeout value");
  });

  it("throws on missing api-key", () => {
    setupInputs({ prompt: "test" });
    expect(() => getInputs()).toThrow("'api-key' is required");
  });

  it("throws on missing prompt", () => {
    setupInputs({ "api-key": "vibe_key" });
    expect(() => getInputs()).toThrow("'prompt' is required");
  });

  it("parses max-turns", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "max-turns": "10",
    });

    const result = getInputs();
    expect(result.maxTurns).toBe(10);
  });

  it("throws on invalid max-turns", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "max-turns": "abc",
    });

    expect(() => getInputs()).toThrow("Invalid max-turns value");
  });

  it("leaves maxTurns undefined when not provided", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
    });

    const result = getInputs();
    expect(result.maxTurns).toBeUndefined();
  });

  it("parses egress-scanning", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "egress-scanning": "relay",
    });

    const result = getInputs();
    expect(result.egressScanning).toBe("relay");
  });

  it("throws on invalid egress-scanning", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "egress-scanning": "disabled",
    });

    expect(() => getInputs()).toThrow("Invalid egress-scanning value");
  });

  it("reads repository from GITHUB_REPOSITORY env", () => {
    setupInputs({ "api-key": "vibe_key", prompt: "test" });
    process.env.GITHUB_REPOSITORY = "vibectl/test-repo";

    const result = getInputs();
    expect(result.repository).toBe("vibectl/test-repo");
    expect(result.repoUrl).toBe("https://github.com/vibectl/test-repo");
  });

  it("handles env input parsing", () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      env: "FOO=bar\nBAZ=qux",
    });

    const result = getInputs();
    expect(result.envVars).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});
