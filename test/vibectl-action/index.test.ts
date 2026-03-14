import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

// Track all core mock calls
const mockSetOutput = mock(() => {});
const mockSetFailed = mock(() => {});
const mockInfo = mock(() => {});
const mockWarning = mock(() => {});
const mockSetSecret = mock(() => {});
const mockGetInput = mock(() => "");

mock.module("@actions/core", () => ({
  getInput: mockGetInput,
  setSecret: mockSetSecret,
  info: mockInfo,
  debug: mock(() => {}),
  warning: mockWarning,
  error: mock(() => {}),
  setOutput: mockSetOutput,
  setFailed: mockSetFailed,
}));

// Import after mock.module
import { run } from "../../src/vibectl-action/run.ts";

function makeStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

describe("run (integration)", () => {
  const originalEnv = { ...process.env };
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    mockSetOutput.mockReset();
    mockSetFailed.mockReset();
    mockInfo.mockReset();
    mockWarning.mockReset();
    mockSetSecret.mockReset();
    mockGetInput.mockReset();
    originalFetch = global.fetch;
    process.env = { ...originalEnv };
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_WORKFLOW;
    delete process.env.GITHUB_RUN_ID;
    delete process.env.GITHUB_EVENT_NAME;
    delete process.env.GITHUB_ACTOR;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  function setupInputs(inputs: Record<string, string>) {
    mockGetInput.mockImplementation(
      ((name: string) => inputs[name] || "") as () => string,
    );
  }

  it("completes full flow: submit + stream + outputs", async () => {
    setupInputs({
      "api-key": "vibe_testkey",
      prompt: "review this code",
      "api-url": "https://api.test.dev",
      timeout: "60",
    });
    process.env.GITHUB_REPOSITORY = "vibectl/test-repo";

    const sseBody = makeStreamFromChunks([
      "event: start\ndata: {}\n\n",
      'event: stdout\ndata: {"data":"review output"}\n\n',
      'event: complete\ndata: {"costUsd":0.03}\n\n',
    ]);

    global.fetch = mock((url: string) => {
      if (url.includes("/v1/tasks") && !url.includes("/stream")) {
        return Promise.resolve(
          new Response(JSON.stringify({ task_id: "task-integration-1" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    await run();

    expect(mockSetOutput).toHaveBeenCalledWith("task-id", "task-integration-1");
    expect(mockSetOutput).toHaveBeenCalledWith("result", "completed");
    expect(mockSetOutput).toHaveBeenCalledWith("output", "review output");
    expect(mockSetOutput).toHaveBeenCalledWith("cost-usd", "0.03");
    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("sets duration-ms output", async () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "api-url": "https://api.test.dev",
      timeout: "60",
    });

    const sseBody = makeStreamFromChunks(["event: complete\ndata: {}\n\n"]);

    global.fetch = mock((url: string) => {
      if (url.includes("/v1/tasks") && !url.includes("/stream")) {
        return Promise.resolve(
          new Response(JSON.stringify({ task_id: "task-dur" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    await run();

    const calls = mockSetOutput.mock.calls as unknown as [string, string][];
    const durationCall = calls.find((c) => c[0] === "duration-ms");
    expect(durationCall).toBeDefined();
    const durationMs = parseInt(durationCall![1], 10);
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });

  it("sets failed on task submission error", async () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "api-url": "https://api.test.dev",
    });

    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "Invalid API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("Task submission failed (401)"),
    );
  });

  it("sets failed on task execution failure", async () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "api-url": "https://api.test.dev",
      timeout: "60",
    });

    const sseBody = makeStreamFromChunks([
      'event: error\ndata: {"error":"container OOM"}\n\n',
    ]);

    global.fetch = mock((url: string) => {
      if (url.includes("/v1/tasks") && !url.includes("/stream")) {
        return Promise.resolve(
          new Response(JSON.stringify({ task_id: "task-fail" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("container OOM"),
    );
  });

  it("sets failed on timeout", async () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "api-url": "https://api.test.dev",
      timeout: "60",
    });

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    global.fetch = mock((url: string) => {
      if (url.includes("/v1/tasks") && !url.includes("/stream")) {
        return Promise.resolve(
          new Response(JSON.stringify({ task_id: "task-timeout" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.reject(abortError);
    }) as unknown as typeof fetch;

    await run();

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("timeout"),
    );
  });

  it("warns on unknown terminal status", async () => {
    setupInputs({
      "api-key": "vibe_key",
      prompt: "test",
      "api-url": "https://api.test.dev",
      timeout: "60",
    });

    // Stream ends without complete or error event
    const sseBody = makeStreamFromChunks([
      'event: stdout\ndata: {"data":"partial"}\n\n',
    ]);

    global.fetch = mock((url: string) => {
      if (url.includes("/v1/tasks") && !url.includes("/stream")) {
        return Promise.resolve(
          new Response(JSON.stringify({ task_id: "task-unknown" }), {
            status: 202,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    await run();

    expect(mockWarning).toHaveBeenCalledWith(
      "Task ended without a terminal status event",
    );
    expect(mockSetOutput).toHaveBeenCalledWith("result", "unknown");
  });

  it("sanitizes API key from error output", async () => {
    setupInputs({
      "api-key": "vibe_supersecret",
      prompt: "test",
      "api-url": "https://api.test.dev",
    });

    global.fetch = mock(() =>
      Promise.reject(
        new Error(
          "Network error with Bearer vibe_supersecret in Authorization",
        ),
      ),
    ) as unknown as typeof fetch;

    await run();

    const failedCalls = mockSetFailed.mock.calls as unknown as [string][];
    const failedCall = failedCalls[0]?.[0];
    expect(failedCall).toBeDefined();
    expect(failedCall).not.toContain("vibe_supersecret");
  });
});
