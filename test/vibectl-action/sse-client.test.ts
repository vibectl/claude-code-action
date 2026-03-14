import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  mock,
} from "bun:test";
import {
  processSSEEvent,
  parseSSELines,
  createStreamState,
  streamTaskOutput,
} from "../../src/vibectl-action/sse-client.ts";
import type { StreamState } from "../../src/vibectl-action/types.ts";

// Mock @actions/core
const mockInfo = mock(() => {});
const mockWarning = mock(() => {});
const mockError = mock(() => {});
const mockDebug = mock(() => {});
mock.module("@actions/core", () => ({
  getInput: mock(() => ""),
  setSecret: mock(() => {}),
  info: mockInfo,
  debug: mockDebug,
  warning: mockWarning,
  error: mockError,
  setOutput: mock(() => {}),
  setFailed: mock(() => {}),
}));

function freshState(): StreamState {
  return createStreamState();
}

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

describe("processSSEEvent", () => {
  beforeEach(() => {
    mockInfo.mockReset();
    mockWarning.mockReset();
    mockError.mockReset();
    mockDebug.mockReset();
  });

  it("handles start event", () => {
    const state = freshState();
    processSSEEvent("start", "{}", state);

    expect(mockInfo).toHaveBeenCalledWith("[vibectl] Task execution started");
    expect(state.status).toBe("unknown");
  });

  it("appends stdout data to output buffer and logs it", () => {
    const state = freshState();
    processSSEEvent("stdout", '{"data":"hello world"}', state);

    expect(state.outputBuffer).toBe("hello world");
    expect(mockInfo).toHaveBeenCalledWith("hello world");
  });

  it("logs stderr data as warning", () => {
    const state = freshState();
    processSSEEvent("stderr", '{"data":"warning msg"}', state);

    expect(mockWarning).toHaveBeenCalledWith("[stderr] warning msg");
    expect(state.outputBuffer).toBe("");
  });

  it("marks status completed on complete event", () => {
    const state = freshState();
    processSSEEvent("complete", '{"costUsd":0.05}', state);

    expect(state.status).toBe("completed");
    expect(state.costUsd).toBe(0.05);
  });

  it("captures exit code on complete event", () => {
    const state = freshState();
    processSSEEvent("complete", '{"exitCode":0}', state);

    expect(state.exitCode).toBe(0);
  });

  it("marks status failed on error event", () => {
    const state = freshState();
    processSSEEvent("error", '{"error":"container crashed"}', state);

    expect(state.status).toBe("failed");
    expect(state.error).toBe("container crashed");
  });

  it("uses default error message when error field is missing", () => {
    const state = freshState();
    processSSEEvent("error", "{}", state);

    expect(state.error).toBe("Unknown error");
  });

  it("ignores invalid JSON gracefully", () => {
    const state = freshState();
    processSSEEvent("stdout", "not-json", state);

    expect(state.outputBuffer).toBe("");
    expect(mockDebug).toHaveBeenCalledWith(
      "Failed to parse SSE data: not-json",
    );
  });

  it("logs unknown event types as debug", () => {
    const state = freshState();
    processSSEEvent("custom-event", "{}", state);

    expect(mockDebug).toHaveBeenCalledWith(
      "Unknown SSE event type: custom-event",
    );
  });

  it("does not append when stdout data field is missing", () => {
    const state = freshState();
    processSSEEvent("stdout", "{}", state);

    expect(state.outputBuffer).toBe("");
  });
});

describe("parseSSELines", () => {
  it("extracts event type and data from complete SSE lines", () => {
    const state = freshState();
    const buffer = 'event: stdout\ndata: {"data":"hello"}\n\n';
    const remainder = parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe("hello");
    expect(remainder).toBe("");
  });

  it("returns incomplete data as remainder", () => {
    const state = freshState();
    const buffer = 'event: stdout\ndata: {"data":"hello"}\npartial';
    const remainder = parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe("hello");
    expect(remainder).toBe("partial");
  });

  it("handles multiple events in a single buffer", () => {
    const state = freshState();
    const buffer =
      'event: stdout\ndata: {"data":"line1"}\nevent: stdout\ndata: {"data":"line2"}\n';
    parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe("line1line2");
  });

  it("handles empty buffer", () => {
    const state = freshState();
    const remainder = parseSSELines("", state);

    expect(remainder).toBe("");
    expect(state.outputBuffer).toBe("");
  });

  it("ignores SSE comment lines (starting with :)", () => {
    const state = freshState();
    const buffer = ':comment\nid: 123\nevent: stdout\ndata: {"data":"ok"}\n';
    parseSSELines(buffer, state);

    expect(state.outputBuffer).toBe("ok");
  });
});

describe("streamTaskOutput", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    mockInfo.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns completed status on successful stream", async () => {
    const sseBody = makeStreamFromChunks([
      "event: start\ndata: {}\n\n",
      'event: stdout\ndata: {"data":"output text"}\n\n',
      'event: complete\ndata: {"costUsd":0.12}\n\n',
    ]);

    global.fetch = mock(() =>
      Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await streamTaskOutput(
      "https://api.test/stream",
      "test-key",
      30000,
    );

    expect(result.status).toBe("completed");
    expect(result.output).toBe("output text");
    expect(result.costUsd).toBe(0.12);
  });

  it("returns failed status on error event", async () => {
    const sseBody = makeStreamFromChunks([
      'event: error\ndata: {"error":"container OOM"}\n\n',
    ]);

    global.fetch = mock(() =>
      Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await streamTaskOutput(
      "https://api.test/stream",
      "test-key",
      30000,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("container OOM");
  });

  it("handles JSON error response instead of SSE stream", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "task not found" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await streamTaskOutput(
      "https://api.test/stream",
      "test-key",
      30000,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("task not found");
  });

  it("handles JSON error with nested object", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "detailed error" } }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    ) as unknown as typeof fetch;

    const result = await streamTaskOutput(
      "https://api.test/stream",
      "test-key",
      30000,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toBe("detailed error");
  });

  it("throws on non-OK HTTP response", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response("Unauthorized", { status: 401 }),
      ),
    ) as unknown as typeof fetch;

    await expect(
      streamTaskOutput("https://api.test/stream", "test-key", 30000),
    ).rejects.toThrow("SSE connection failed (401)");
  });

  it("returns timeout status when abort signal fires", async () => {
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";

    global.fetch = mock(() =>
      Promise.reject(abortError),
    ) as unknown as typeof fetch;

    const result = await streamTaskOutput(
      "https://api.test/stream",
      "test-key",
      100,
    );

    expect(result.status).toBe("timeout");
    expect(result.error).toContain("timeout");
  });

  it("sends correct authorization and accept headers", async () => {
    let capturedHeaders: Record<string, string> = {};
    const sseBody = makeStreamFromChunks([
      "event: complete\ndata: {}\n\n",
    ]);

    global.fetch = mock((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    }) as unknown as typeof fetch;

    await streamTaskOutput(
      "https://api.test/stream",
      "my-api-key",
      30000,
    );

    expect(capturedHeaders["Authorization"]).toBe("Bearer my-api-key");
    expect(capturedHeaders["Accept"]).toBe("text/event-stream");
    expect(capturedHeaders["User-Agent"]).toBe("vibectl-github-action/1.0");
  });

  it("returns unknown status when stream ends without terminal event", async () => {
    const sseBody = makeStreamFromChunks([
      'event: stdout\ndata: {"data":"partial"}\n\n',
    ]);

    global.fetch = mock(() =>
      Promise.resolve(
        new Response(sseBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      ),
    ) as unknown as typeof fetch;

    const result = await streamTaskOutput(
      "https://api.test/stream",
      "test-key",
      30000,
    );

    expect(result.status).toBe("unknown");
    expect(result.output).toBe("partial");
  });

  it("sanitizes sensitive data in SSE error responses", async () => {
    global.fetch = mock(() =>
      Promise.resolve(
        new Response("Bearer vibe_secret was invalid", { status: 401 }),
      ),
    ) as unknown as typeof fetch;

    try {
      await streamTaskOutput("https://api.test/stream", "test-key", 30000);
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain("vibe_secret");
    }
  });
});
