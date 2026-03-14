/**
 * SSE (Server-Sent Events) streaming client.
 *
 * Connects to the task streaming endpoint, parses SSE events,
 * logs stdout/stderr to workflow logs in real-time, and returns
 * the final result when a terminal event is received.
 */

import * as core from "@actions/core";
import type { SSEEventData, StreamResult, StreamState } from "./types.ts";
import { sanitizeMessage } from "./errors.ts";

/**
 * Process a single SSE event, updating the stream state and logging output.
 */
export function processSSEEvent(
  eventType: string,
  eventData: string,
  state: StreamState,
): void {
  let event: SSEEventData;
  try {
    event = JSON.parse(eventData) as SSEEventData;
  } catch {
    core.debug(`Failed to parse SSE data: ${eventData}`);
    return;
  }

  switch (eventType) {
    case "start":
      core.info("[vibectl] Task execution started");
      break;

    case "stdout":
      if (event.data) {
        core.info(event.data);
        state.outputBuffer += event.data;
      }
      break;

    case "stderr":
      if (event.data) {
        core.warning(`[stderr] ${event.data}`);
      }
      break;

    case "complete":
      state.status = "completed";
      core.info("[vibectl] Task completed");
      if (event.costUsd !== undefined) {
        state.costUsd = event.costUsd;
      }
      if (event.exitCode !== undefined) {
        state.exitCode = event.exitCode;
      }
      break;

    case "error":
      state.status = "failed";
      state.error = event.error || "Unknown error";
      core.error(`[vibectl] Task failed: ${sanitizeMessage(state.error)}`);
      break;

    default:
      core.debug(`Unknown SSE event type: ${eventType}`);
  }
}

/**
 * Parse complete SSE lines from a buffer, extracting event type and data pairs.
 * Returns any remaining incomplete data left in the buffer.
 */
export function parseSSELines(buffer: string, state: StreamState): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop() || "";

  let eventType = "";

  for (const line of lines) {
    if (line.startsWith("event: ")) {
      eventType = line.substring(7).trim();
    } else if (line.startsWith("data: ")) {
      const eventData = line.substring(6);
      processSSEEvent(eventType, eventData, state);
      eventType = "";
    }
    // SSE spec: lines starting with ':' are comments, skip them
    // Empty lines between events are normal, skip them
  }

  return remainder;
}

/**
 * Create a fresh stream state for accumulating SSE events.
 */
export function createStreamState(): StreamState {
  return {
    outputBuffer: "",
    status: "unknown",
    error: null,
    costUsd: undefined,
    exitCode: undefined,
  };
}

/**
 * Stream task output via the SSE endpoint.
 *
 * Connects to GET /v1/tasks/:id/stream, reads SSE events,
 * logs output in real-time, and returns the final result
 * when a terminal event (complete/error) is received or timeout expires.
 */
export async function streamTaskOutput(
  url: string,
  apiKey: string,
  timeoutMs: number,
): Promise<StreamResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const state = createStreamState();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "text/event-stream",
        "User-Agent": "vibectl-github-action/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        sanitizeMessage(
          `SSE connection failed (${response.status}): ${errorText}`,
        ),
      );
    }

    // Handle case where API returns JSON instead of SSE stream
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const jsonResponse = (await response.json()) as {
        error?: { message?: string } | string;
      };
      if (jsonResponse.error) {
        const errorMsg =
          typeof jsonResponse.error === "object"
            ? jsonResponse.error.message
            : jsonResponse.error;
        return {
          status: "failed",
          error: sanitizeMessage(errorMsg || "Unknown error"),
        };
      }
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = parseSSELines(buffer, state);

      if (state.status === "completed" || state.status === "failed") {
        break;
      }
    }

    clearTimeout(timeoutId);

    return {
      status: state.status,
      output: state.outputBuffer || undefined,
      costUsd: state.costUsd,
      error: state.error,
      exitCode: state.exitCode,
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === "AbortError") {
      return {
        status: "timeout",
        error: `Task exceeded timeout (${Math.round(timeoutMs / 1000)}s)`,
      };
    }

    throw err;
  }
}
