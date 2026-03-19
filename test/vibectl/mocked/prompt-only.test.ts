#!/usr/bin/env bun
// @ts-nocheck — test file uses flexible mock return types
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import type { TaskPayload } from "../../../src/vibectl/entry-adapter.ts";

/**
 * Prompt-only execution path tests.
 *
 * Validates that the entry adapter correctly handles tasks without
 * GitHub webhook context — executing via the Agent SDK with a plain
 * prompt, bypassing all GitHub API calls and webhook-specific logic.
 *
 * Separated from entry-adapter.test.ts because Bun's mock.module()
 * caches per-process — each test file in mocked/ gets isolated mocks.
 */

// Define mock functions
const mockRunClaude = mock(() =>
  Promise.resolve({
    conclusion: "success" as const,
    executionFile: "/tmp/execution.json",
    sessionId: "prompt-only-session",
  }),
);
const mockValidateEnv = mock(() => {});
const mockSetupSettings = mock(() => Promise.resolve());
const mockPreparePrompt = mock(() =>
  Promise.resolve({ type: "file" as const, path: "/tmp/prompt.txt" }),
);
const mockInstallPlugins = mock(() => Promise.resolve());
const mockCollectInputs = mock(() => JSON.stringify({}));

// GitHub-specific mocks — these must NOT be called during prompt-only execution
const mockParseGitHubContext = mock(() => {
  throw new Error("parseGitHubContext called during prompt-only execution");
});
const mockIsEntityContext = mock(() => false);
const mockDetectMode = mock(() => {
  throw new Error("detectMode called during prompt-only execution");
});
const mockCreateOctokit = mock(() => {
  throw new Error("createOctokit called during prompt-only execution");
});
const mockCheckWritePermissions = mock(() => {
  throw new Error(
    "checkWritePermissions called during prompt-only execution",
  );
});
const mockCheckContainsTrigger = mock(() => {
  throw new Error(
    "checkContainsTrigger called during prompt-only execution",
  );
});
const mockPrepareTagMode = mock(() => {
  throw new Error("prepareTagMode called during prompt-only execution");
});
const mockPrepareAgentMode = mock(() => {
  throw new Error("prepareAgentMode called during prompt-only execution");
});

// Register mock.module calls before adapter import
mock.module("../../../src/github/context.ts", () => ({
  parseGitHubContext: mockParseGitHubContext,
  isEntityContext: mockIsEntityContext,
}));
mock.module("../../../src/modes/detector.ts", () => ({
  detectMode: mockDetectMode,
}));
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
mock.module("../../../src/github/validation/trigger.ts", () => ({
  checkContainsTrigger: mockCheckContainsTrigger,
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
mock.module("../../../base-action/src/install-plugins.ts", () => ({
  installPlugins: mockInstallPlugins,
}));
mock.module("../../../src/entrypoints/collect-inputs.ts", () => ({
  collectActionInputsPresence: mockCollectInputs,
}));

// Import after mocks are registered
const { executeTask } = await import("../../../src/vibectl/entry-adapter.ts");

function createPromptOnlyPayload(
  overrides?: Partial<TaskPayload>,
): TaskPayload {
  return {
    credentials: {
      aiProxyUrl: "https://ai-proxy.vibectl.dev/v1/proxy/cust_123",
      proxyHeaders: { "X-Proxy-Token": "test-hmac" },
    },
    prompt: "Analyze the repository structure",
    ...overrides,
  };
}

function resetMocks() {
  const safeMocks = [
    mockRunClaude,
    mockValidateEnv,
    mockSetupSettings,
    mockPreparePrompt,
    mockInstallPlugins,
    mockCollectInputs,
  ];
  for (const m of safeMocks) {
    m.mockClear();
  }

  // Reset safe mocks to defaults
  mockRunClaude.mockImplementation(() =>
    Promise.resolve({
      conclusion: "success" as const,
      executionFile: "/tmp/execution.json",
      sessionId: "prompt-only-session",
    }),
  );
  mockValidateEnv.mockImplementation(() => {});
  mockSetupSettings.mockImplementation(() => Promise.resolve());
  mockPreparePrompt.mockImplementation(() =>
    Promise.resolve({ type: "file" as const, path: "/tmp/prompt.txt" }),
  );
  mockInstallPlugins.mockImplementation(() => Promise.resolve());
  mockCollectInputs.mockImplementation(() => JSON.stringify({}));

  // GitHub mocks stay as throwing — they must not be called
  const githubMocks = [
    mockParseGitHubContext,
    mockIsEntityContext,
    mockDetectMode,
    mockCreateOctokit,
    mockCheckWritePermissions,
    mockCheckContainsTrigger,
    mockPrepareTagMode,
    mockPrepareAgentMode,
  ];
  for (const m of githubMocks) {
    m.mockClear();
  }
}

describe("prompt-only execution", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
    resetMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("returns valid AdapterResult with success: true for prompt-only payload", async () => {
    const result = await executeTask(createPromptOnlyPayload());
    expect(result.success).toBe(true);
    expect(result.mode).toBe("agent");
    expect(result.sessionId).toBe("prompt-only-session");
  });

  test("returns executionFile from SDK result", async () => {
    const result = await executeTask(createPromptOnlyPayload());
    expect(result.executionFile).toBe("/tmp/execution.json");
  });

  test("calls runClaude with prompt content", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockRunClaude).toHaveBeenCalledTimes(1);
  });

  test("passes permission bypass args to runClaude", async () => {
    await executeTask(createPromptOnlyPayload());
    const callArgs = mockRunClaude.mock.calls[0];
    const options = callArgs?.[1] as Record<string, unknown> | undefined;
    expect(options?.claudeArgs).toContain("--permission-mode bypassPermissions");
    expect(options?.claudeArgs).toContain("--dangerously-skip-permissions");
  });

  test("does not call parseGitHubContext", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockParseGitHubContext).not.toHaveBeenCalled();
  });

  test("does not call detectMode", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockDetectMode).not.toHaveBeenCalled();
  });

  test("does not call createOctokit", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockCreateOctokit).not.toHaveBeenCalled();
  });

  test("does not call checkWritePermissions", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockCheckWritePermissions).not.toHaveBeenCalled();
  });

  test("does not call prepareTagMode or prepareAgentMode", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockPrepareTagMode).not.toHaveBeenCalled();
    expect(mockPrepareAgentMode).not.toHaveBeenCalled();
  });

  test("sets ANTHROPIC_BASE_URL from credentials", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      "https://ai-proxy.vibectl.dev/v1/proxy/cust_123",
    );
  });

  test("sets ANTHROPIC_API_KEY placeholder", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(process.env.ANTHROPIC_API_KEY).toBeTruthy();
  });

  test("sets ANTHROPIC_CUSTOM_HEADERS from proxy headers", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toContain("X-Proxy-Token");
  });

  test("calls validateEnvironmentVariables", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(mockValidateEnv).toHaveBeenCalled();
  });

  test("returns failure when prompt is missing from prompt-only payload", async () => {
    const payload = createPromptOnlyPayload({ prompt: undefined });
    const result = await executeTask(payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain("prompt");
  });

  test("returns failure when prompt is empty string", async () => {
    const payload = createPromptOnlyPayload({ prompt: "" });
    const result = await executeTask(payload);
    expect(result.success).toBe(false);
    expect(result.error).toContain("prompt");
  });

  test("returns failure with stage prefix when runClaude throws", async () => {
    mockRunClaude.mockImplementation(() =>
      Promise.reject(new Error("SDK connection failed")),
    );

    const result = await executeTask(createPromptOnlyPayload());
    expect(result.success).toBe(false);
    expect(result.error).toContain("execute");
    expect(result.error).toContain("SDK connection failed");
  });

  test("does not set VIBECTL_CONTEXT_JSON for prompt-only payload", async () => {
    delete process.env.VIBECTL_CONTEXT_JSON;
    await executeTask(createPromptOnlyPayload());
    expect(process.env.VIBECTL_CONTEXT_JSON).toBeUndefined();
  });

  test("does not set GITHUB_TOKEN for prompt-only payload", async () => {
    delete process.env.GITHUB_TOKEN;
    await executeTask(createPromptOnlyPayload());
    expect(process.env.GITHUB_TOKEN).toBeUndefined();
  });

  test("sets RUNNER_TEMP to a valid temp directory", async () => {
    await executeTask(createPromptOnlyPayload());
    expect(process.env.RUNNER_TEMP).toBeTruthy();
    expect(process.env.RUNNER_TEMP).toContain("vibectl-");
  });

  test("handles SDK failure conclusion correctly", async () => {
    mockRunClaude.mockImplementation(() =>
      Promise.resolve({
        conclusion: "failure" as const,
        executionFile: undefined,
        sessionId: undefined,
      }),
    );

    const result = await executeTask(createPromptOnlyPayload());
    expect(result.success).toBe(false);
    expect(result.mode).toBe("agent");
  });

  test("preserves metrics from successful execution", async () => {
    mockRunClaude.mockImplementation(() =>
      Promise.resolve({
        conclusion: "success" as const,
        executionFile: undefined,
        sessionId: "session-with-metrics",
      }),
    );

    const result = await executeTask(createPromptOnlyPayload());
    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("session-with-metrics");
  });
});
