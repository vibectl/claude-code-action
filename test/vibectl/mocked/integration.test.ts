#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Integration test: mock task payload → entry adapter → CCA internals → output scanning.
 *
 * Verifies the full orchestration flow:
 * 1. Task payload is parsed and env vars are configured
 * 2. GitHub context is constructed via VIBECTL_CONTEXT_JSON (Phase 2 patch)
 * 3. CCA's mode detection runs on the constructed context
 * 4. Mode-specific preparation is invoked
 * 5. Claude SDK execution produces output
 * 6. Output scanner detects secrets in execution output
 *
 * CCA network-calling functions are mocked; context parsing and mode
 * detection use real CCA code to validate Phase 2 patches.
 */

// Create a temp directory for test execution output
const testTempDir = mkdtempSync(join(tmpdir(), "vibectl-integ-"));

// Mock network-calling CCA modules
const mockPrepareTagMode = mock(() =>
  Promise.resolve({
    commentId: 99999,
    branchInfo: {
      baseBranch: "main",
      currentBranch: "main",
      claudeBranch: "vibectl/issue-42",
    },
    mcpConfig: "{}",
    claudeArgs: "--permission-mode acceptEdits",
  }),
);
const mockPrepareAgentMode = mock(() =>
  Promise.resolve({
    commentId: undefined,
    branchInfo: {
      baseBranch: "main",
      currentBranch: "main",
      claudeBranch: undefined,
    },
    mcpConfig: "{}",
    claudeArgs: "",
  }),
);
const mockCreateOctokit = mock(() => ({
  rest: {},
  graphql: {},
}));
const mockCheckWritePermissions = mock(() => Promise.resolve(true));
const mockValidateEnv = mock(() => {});
const mockSetupSettings = mock(() => Promise.resolve());
const mockPreparePrompt = mock(() =>
  Promise.resolve({ type: "file" as const, path: "/tmp/prompt.txt" }),
);
const mockRunClaude = mock(() => {
  // Write a mock execution output file
  const execFile = join(testTempDir, "claude-execution-output.json");
  writeFileSync(
    execFile,
    JSON.stringify([
      {
        role: "assistant",
        content: "I reviewed the code. Everything looks good.",
      },
    ]),
  );
  return Promise.resolve({
    conclusion: "success" as const,
    executionFile: execFile,
    sessionId: "integration-test-session",
  });
});

// Register mocks — mock modules that make network calls or modify host state
mock.module("../../../src/modes/tag/index.ts", () => ({
  prepareTagMode: mockPrepareTagMode,
}));
mock.module("../../../src/modes/agent/index.ts", () => ({
  prepareAgentMode: mockPrepareAgentMode,
}));
mock.module("../../../src/github/api/client.ts", () => ({
  createOctokit: mockCreateOctokit,
}));
mock.module("../../../src/github/validation/permissions.ts", () => ({
  checkWritePermissions: mockCheckWritePermissions,
}));
mock.module("../../../base-action/src/validate-env.ts", () => ({
  validateEnvironmentVariables: mockValidateEnv,
}));
mock.module("../../../base-action/src/setup-claude-code-settings.ts", () => ({
  setupClaudeCodeSettings: mockSetupSettings,
}));
mock.module("../../../base-action/src/prepare-prompt.ts", () => ({
  preparePrompt: mockPreparePrompt,
}));
mock.module("../../../base-action/src/run-claude.ts", () => ({
  runClaude: mockRunClaude,
}));

// Import after mocks
const { executeTask } = await import("../../../src/vibectl/entry-adapter.ts");
const { scanForSecrets } = await import(
  "../../../src/vibectl/output-scanner.ts"
);

describe("integration: adapter → CCA internals → output scanning", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Reset mocks
    mockPrepareTagMode.mockClear();
    mockPrepareAgentMode.mockClear();
    mockCheckWritePermissions.mockClear();
    mockRunClaude.mockClear();

    mockCheckWritePermissions.mockImplementation(() => Promise.resolve(true));
    mockRunClaude.mockImplementation(() => {
      const execFile = join(testTempDir, "claude-execution-output.json");
      writeFileSync(
        execFile,
        JSON.stringify([
          {
            role: "assistant",
            content: "I reviewed the code. Everything looks good.",
          },
        ]),
      );
      return Promise.resolve({
        conclusion: "success" as const,
        executionFile: execFile,
        sessionId: "integration-test-session",
      });
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("full flow: issue_comment payload → adapter configures env → tag mode detected → SDK executes → output scanned (clean)", async () => {
    // Set trigger phrase so CCA's parseGitHubContext reads it
    process.env.TRIGGER_PHRASE = "@vibectl";

    const payload = {
      credentials: {
        githubToken: "ghs_testtoken1234567890abcdefghijklmnop",
        aiProxyUrl: "https://ai-proxy.vibectl.dev/v1/proxy/cust_123",
        proxyHeaders: { "X-Proxy-Token": "test-hmac" },
        repoOwner: "test-owner",
        repoName: "test-repo",
        eventName: "issue_comment",
        botUserId: "999999",
        botLogin: "vibectl[bot]",
      },
      contextJson: {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: {
            number: 42,
            title: "Test issue",
            body: "Issue body",
            pull_request: undefined,
            user: { login: "test-user", id: 123 },
          },
          comment: {
            id: 1,
            body: "@vibectl review this code",
            user: { login: "test-user", id: 123 },
            created_at: "2026-01-01T00:00:00Z",
          },
          repository: {
            name: "test-repo",
            full_name: "test-owner/test-repo",
            owner: { login: "test-owner" },
          },
        },
        repo: { owner: "test-owner", repo: "test-repo" },
        actor: "test-user",
      },
    };

    const result = await executeTask(payload);

    // Verify the full flow completed
    expect(result.success).toBe(true);
    expect(result.mode).toBe("tag");
    expect(result.sessionId).toBe("integration-test-session");

    // Verify CCA internals were orchestrated correctly
    expect(mockPrepareTagMode).toHaveBeenCalled();
    expect(mockRunClaude).toHaveBeenCalled();

    // Verify output was scanned (clean — no secrets)
    expect(result.scanResult).toBeDefined();
    expect(result.scanResult!.containsSecrets).toBe(false);

    // Verify env was configured by auth bridge
    expect(process.env.GITHUB_TOKEN).toBe(
      "ghs_testtoken1234567890abcdefghijklmnop",
    );
    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      "https://ai-proxy.vibectl.dev/v1/proxy/cust_123",
    );
    expect(process.env.BOT_USER_ID).toBe("999999");
    expect(process.env.BOT_LOGIN).toBe("vibectl[bot]");
    expect(process.env.VIBECTL_CONTEXT_JSON).toBeTruthy();
  });

  test("full flow with secret in output: scanner detects and flags", async () => {
    process.env.TRIGGER_PHRASE = "@vibectl";

    // Override runClaude to produce output containing a secret
    mockRunClaude.mockImplementation(() => {
      const execFile = join(testTempDir, "claude-execution-secret.json");
      writeFileSync(
        execFile,
        JSON.stringify([
          {
            role: "assistant",
            content:
              "Found a config file with token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
          },
        ]),
      );
      return Promise.resolve({
        conclusion: "success" as const,
        executionFile: execFile,
        sessionId: "secret-test-session",
      });
    });

    const payload = {
      credentials: {
        githubToken: "ghs_testtoken1234567890abcdefghijklmnop",
        aiProxyUrl: "https://ai-proxy.vibectl.dev/v1/proxy/cust_123",
        proxyHeaders: { "X-Proxy-Token": "test-hmac" },
        repoOwner: "test-owner",
        repoName: "test-repo",
        eventName: "issue_comment",
        botUserId: "999999",
        botLogin: "vibectl[bot]",
      },
      contextJson: {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: {
            number: 42,
            title: "Test issue",
            body: "Issue body",
            pull_request: undefined,
            user: { login: "test-user", id: 123 },
          },
          comment: {
            id: 1,
            body: "@vibectl review this code",
            user: { login: "test-user", id: 123 },
            created_at: "2026-01-01T00:00:00Z",
          },
          repository: {
            name: "test-repo",
            full_name: "test-owner/test-repo",
            owner: { login: "test-owner" },
          },
        },
        repo: { owner: "test-owner", repo: "test-repo" },
        actor: "test-user",
      },
    };

    const result = await executeTask(payload);

    // Execution succeeds (CCA completed)
    expect(result.success).toBe(true);

    // Scanner detects the GitHub PAT in the output
    expect(result.scanResult).toBeDefined();
    expect(result.scanResult!.containsSecrets).toBe(true);
    expect(result.scanResult!.matchCount).toBeGreaterThanOrEqual(1);
    expect(
      result.scanResult!.findings.some(
        (f) => f.patternName === "github-pat-classic",
      ),
    ).toBe(true);
  });

  test("output scanner works independently on raw text", () => {
    const cleanText = "This is a normal code review with no secrets.";
    const cleanResult = scanForSecrets(cleanText);
    expect(cleanResult.containsSecrets).toBe(false);

    const dirtyText = [
      "Here is the API key:",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "And a private key:",
      "-----BEGIN RSA PRIVATE KEY-----",
    ].join("\n");
    const dirtyResult = scanForSecrets(dirtyText);
    expect(dirtyResult.containsSecrets).toBe(true);
    expect(dirtyResult.matchCount).toBe(2);
  });
});
