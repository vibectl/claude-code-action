/**
 * Integration test for the vibectl GitHub Action.
 *
 * Validates the action's core functionality against a live API:
 * 1. Task submission via POST /v1/tasks
 * 2. SSE streaming via GET /v1/tasks/:id/stream
 * 3. Structured output retrieval via GET /v1/tasks/:id
 *
 * Environment variables:
 *   E2E_API_KEY    - vibectl API key (required)
 *   E2E_API_URL    - API endpoint (default: https://vibectl-api-dev.vibectl-dev.workers.dev)
 *   E2E_TIMEOUT_MS - Timeout in milliseconds (default: 120000)
 */

const API_KEY = process.env.E2E_API_KEY;
const API_URL =
  process.env.E2E_API_URL || "https://vibectl-api-dev.vibectl-dev.workers.dev";
const TIMEOUT_MS = parseInt(process.env.E2E_TIMEOUT_MS || "120000", 10);

if (!API_KEY) {
  console.error("E2E_API_KEY environment variable is required");
  process.exit(1);
}

interface TaskSubmissionResponse {
  task_id?: string;
  status?: string;
  error?: string;
}

interface TaskStatusResponse {
  id: string;
  status: string;
  result?: {
    stdout?: string;
    exit_code?: number;
  };
  error?: string;
}

interface SSEEventData {
  data?: string;
  error?: string;
  costUsd?: number;
  exitCode?: number;
}

async function submitTask(): Promise<string> {
  console.log(`[integration-test] Submitting task to ${API_URL}/v1/tasks`);

  const payload = {
    type: "exec",
    payload: {
      prompt: "echo 'vibectl-integration-test-ok'",
      trigger_method: "github_action",
      workflow_name: "integration-test",
      workflow_run_id: process.env.GITHUB_RUN_ID || "local",
      workflow_event_name: "push",
      workflow_actor: "integration-test",
    },
    timeout_seconds: 60,
  };

  const response = await fetch(`${API_URL}/v1/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "vibectl-integration-test/1.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Task submission failed (${response.status}): ${errorText}`,
    );
  }

  const data = (await response.json()) as TaskSubmissionResponse;
  if (!data.task_id) {
    throw new Error(
      `Invalid API response: missing task_id. Got: ${JSON.stringify(data)}`,
    );
  }

  console.log(`[integration-test] Task submitted. ID: ${data.task_id}`);
  return data.task_id;
}

async function streamOutput(taskId: string): Promise<{
  status: string;
  output: string;
  receivedEvents: string[];
}> {
  console.log(
    `[integration-test] Streaming output from ${API_URL}/v1/tasks/${taskId}/stream`,
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const receivedEvents: string[] = [];
  let output = "";
  let status = "unknown";

  try {
    const response = await fetch(`${API_URL}/v1/tasks/${taskId}/stream`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        Accept: "text/event-stream",
        "User-Agent": "vibectl-integration-test/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `SSE connection failed (${response.status}): ${errorText}`,
      );
    }

    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = "";
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.substring(7).trim();
        } else if (line.startsWith("data: ")) {
          const eventData = line.substring(6);
          receivedEvents.push(eventType);

          try {
            const event = JSON.parse(eventData) as SSEEventData;
            if (eventType === "stdout" && event.data) {
              output += event.data;
            } else if (eventType === "complete") {
              status = "completed";
            } else if (eventType === "error") {
              status = "failed";
            }
          } catch {
            // Non-JSON event data, skip
          }

          eventType = "";
        }
      }

      if (status === "completed" || status === "failed") {
        break;
      }
    }

    clearTimeout(timeoutId);
    return { status, output, receivedEvents };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "timeout", output, receivedEvents };
    }
    throw err;
  }
}

async function getTaskStatus(taskId: string): Promise<TaskStatusResponse> {
  console.log(
    `[integration-test] Fetching task status from ${API_URL}/v1/tasks/${taskId}`,
  );

  const response = await fetch(`${API_URL}/v1/tasks/${taskId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "User-Agent": "vibectl-integration-test/1.0",
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Task status check failed (${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as TaskStatusResponse;
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function main(): Promise<void> {
  console.log("[integration-test] Starting integration test");
  console.log(`[integration-test] API URL: ${API_URL}`);
  console.log(`[integration-test] Timeout: ${TIMEOUT_MS}ms`);

  const startTime = Date.now();

  // Step 1: Submit task
  const taskId = await submitTask();
  assert(taskId.length > 0, "task_id should be non-empty");
  console.log(`[integration-test] PASS: task submitted, id=${taskId}`);

  // Step 2: Stream output
  const streamResult = await streamOutput(taskId);
  console.log(
    `[integration-test] Stream result: status=${streamResult.status}, events=${streamResult.receivedEvents.length}`,
  );
  console.log(
    `[integration-test] Event types received: ${[...new Set(streamResult.receivedEvents)].join(", ")}`,
  );

  assert(
    streamResult.receivedEvents.length > 0,
    "should receive at least one SSE event",
  );
  console.log("[integration-test] PASS: SSE stream received events");

  // Step 3: Verify structured results via status endpoint
  const taskStatus = await getTaskStatus(taskId);
  console.log(
    `[integration-test] Task status: ${JSON.stringify(taskStatus, null, 2)}`,
  );

  assert(taskStatus.id === taskId, "task status id should match submitted id");
  console.log("[integration-test] PASS: task status id matches");

  assert(
    typeof taskStatus.status === "string" && taskStatus.status.length > 0,
    "task status should have a status field",
  );
  console.log(
    `[integration-test] PASS: task has status '${taskStatus.status}'`,
  );

  const duration = Date.now() - startTime;
  console.log(`[integration-test] Duration: ${duration}ms`);

  // Summary
  console.log("\n[integration-test] === RESULTS ===");
  console.log(`[integration-test] task-id: ${taskId}`);
  console.log(`[integration-test] result: ${streamResult.status}`);
  console.log(`[integration-test] duration-ms: ${duration}`);
  console.log(
    `[integration-test] output: ${streamResult.output.substring(0, 200) || "(empty)"}`,
  );
  console.log(
    `[integration-test] sse-events: ${streamResult.receivedEvents.length}`,
  );
  console.log("[integration-test] === ALL CHECKS PASSED ===");
}

main().catch((err) => {
  console.error(`[integration-test] FAILED: ${err}`);
  process.exit(1);
});
