import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  buildTaskPayload,
  submitTask,
} from "../../src/vibectl-action/api-client.ts";
import type { ActionInputs } from "../../src/vibectl-action/types.ts";

// Mock @actions/core
mock.module("@actions/core", () => ({
  getInput: mock(() => ""),
  setSecret: mock(() => {}),
  info: mock(() => {}),
  debug: mock(() => {}),
  warning: mock(() => {}),
  error: mock(() => {}),
  setOutput: mock(() => {}),
  setFailed: mock(() => {}),
}));

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return {
    apiKey: "vibe_testkey",
    prompt: "review this code",
    apiUrl: "https://api.test.dev",
    timeoutSeconds: 1800,
    envVars: {},
    maxTurns: undefined,
    repository: "vibectl/test-repo",
    repoUrl: "https://github.com/vibectl/test-repo",
    githubToken: "ghs_fake",
    egressScanning: undefined,
    ...overrides,
  };
}

describe("buildTaskPayload", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.GITHUB_WORKFLOW = "CI";
    process.env.GITHUB_RUN_ID = "12345";
    process.env.GITHUB_EVENT_NAME = "push";
    process.env.GITHUB_ACTOR = "octocat";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("builds correct base payload", () => {
    const payload = buildTaskPayload(makeInputs());

    expect(payload.type).toBe("exec");
    expect(payload.payload.prompt).toBe("review this code");
    expect(payload.payload.repository).toBe("vibectl/test-repo");
    expect(payload.payload.repo_url).toBe(
      "https://github.com/vibectl/test-repo",
    );
    expect(payload.payload.github_token).toBe("ghs_fake");
    expect(payload.payload.trigger_method).toBe("github_action");
    expect(payload.timeout_seconds).toBe(1800);
  });

  it("includes workflow metadata from env vars", () => {
    const payload = buildTaskPayload(makeInputs());

    expect(payload.payload.workflow_name).toBe("CI");
    expect(payload.payload.workflow_run_id).toBe("12345");
    expect(payload.payload.workflow_event_name).toBe("push");
    expect(payload.payload.workflow_actor).toBe("octocat");
  });

  it("omits pipeline_config_overrides when no overrides exist", () => {
    const payload = buildTaskPayload(makeInputs());
    expect(payload.pipeline_config_overrides).toBeUndefined();
  });

  it("includes env_vars in pipeline_config_overrides", () => {
    const payload = buildTaskPayload(
      makeInputs({
        envVars: { DB_URL: "postgres://localhost/db", API_TOKEN: "secret" },
      }),
    );

    expect(payload.pipeline_config_overrides?.env_vars).toEqual({
      DB_URL: "postgres://localhost/db",
      API_TOKEN: "secret",
    });
  });

  it("includes egress_scanning in pipeline_config_overrides", () => {
    const payload = buildTaskPayload(
      makeInputs({ egressScanning: "relay" }),
    );

    expect(payload.pipeline_config_overrides?.egress_scanning).toBe("relay");
  });

  it("includes both env_vars and egress_scanning when both present", () => {
    const payload = buildTaskPayload(
      makeInputs({
        envVars: { FOO: "bar" },
        egressScanning: "full",
      }),
    );

    expect(payload.pipeline_config_overrides?.env_vars).toEqual({ FOO: "bar" });
    expect(payload.pipeline_config_overrides?.egress_scanning).toBe("full");
  });

  it("includes max_turns when provided", () => {
    const payload = buildTaskPayload(makeInputs({ maxTurns: 10 }));
    expect(payload.payload.max_turns).toBe(10);
  });

  it("omits max_turns when undefined", () => {
    const payload = buildTaskPayload(makeInputs());
    expect(payload.payload.max_turns).toBeUndefined();
  });

  it("sets repo_url to undefined when repoUrl is empty", () => {
    const payload = buildTaskPayload(
      makeInputs({ repository: "", repoUrl: "" }),
    );
    expect(payload.payload.repo_url).toBeUndefined();
  });

  it("uses empty strings for missing workflow env vars", () => {
    delete process.env.GITHUB_WORKFLOW;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_ACTOR;

    const payload = buildTaskPayload(makeInputs());

    expect(payload.payload.workflow_name).toBe("");
    expect(payload.payload.workflow_run_id).toBe("");
    expect(payload.payload.workflow_event_name).toBe("");
    expect(payload.payload.workflow_actor).toBe("");
  });
});

describe("submitTask", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("submits task and returns task_id on success", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ task_id: "task-abc-123" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const taskId = await submitTask(makeInputs());
    expect(taskId).toBe("task-abc-123");
  });

  it("sends correct authorization header", async () => {
    let capturedHeaders: Record<string, string> = {};
    global.fetch = mock((_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      capturedHeaders = headers;
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "t1" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    await submitTask(makeInputs({ apiKey: "vibe_mykey" }));

    expect(capturedHeaders["Authorization"]).toBe("Bearer vibe_mykey");
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(capturedHeaders["User-Agent"]).toBe("vibectl-github-action/1.0");
  });

  it("posts to /v1/tasks on the configured API URL", async () => {
    let capturedUrl = "";
    global.fetch = mock((url: string) => {
      capturedUrl = url;
      return Promise.resolve(
        new Response(JSON.stringify({ task_id: "t1" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;

    await submitTask(makeInputs({ apiUrl: "https://custom.api.dev" }));
    expect(capturedUrl).toBe("https://custom.api.dev/v1/tasks");
  });

  it("throws on non-OK response with error body", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(submitTask(makeInputs())).rejects.toThrow(
      "Task submission failed (401)",
    );
  });

  it("throws on non-OK response with text body", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response("Bad Gateway", {
          status: 502,
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(submitTask(makeInputs())).rejects.toThrow(
      "Task submission failed (502)",
    );
  });

  it("throws when response is missing task_id", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ status: "queued" }), {
          status: 202,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await expect(submitTask(makeInputs())).rejects.toThrow(
      "Invalid API response: missing task_id",
    );
  });

  it("sanitizes sensitive data from error messages", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Invalid token: Bearer vibe_secret123",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
      ),
    ) as unknown as typeof fetch;

    try {
      await submitTask(makeInputs());
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("vibe_secret123");
    }
  });
});
