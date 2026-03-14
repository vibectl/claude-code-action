/**
 * Main run function for the vibectl GitHub Action.
 *
 * Submits a task to the vibectl REST API, streams real-time output
 * via SSE, and maps task results to action outputs.
 *
 * Execution flow:
 * 1. Parse and validate action inputs
 * 2. Mask secrets (API key, GitHub token)
 * 3. Submit task to POST /v1/tasks
 * 4. Stream output via GET /v1/tasks/:id/stream
 * 5. Set action outputs from task result
 */

import * as core from "@actions/core";
import { getInputs } from "./inputs.ts";
import { submitTask } from "./api-client.ts";
import { streamTaskOutput } from "./sse-client.ts";
import { getErrorMessage } from "./errors.ts";

export async function run(): Promise<void> {
  try {
    const inputs = getInputs();

    core.info(`Submitting task to vibectl API: ${inputs.apiUrl}`);
    core.info(`Timeout: ${inputs.timeoutSeconds}s`);

    const taskId = await submitTask(inputs);
    core.info(`Task submitted. ID: ${taskId}`);
    core.setOutput("task-id", taskId);

    const startTime = Date.now();
    core.info("Streaming task output...");

    const streamUrl = `${inputs.apiUrl}/v1/tasks/${taskId}/stream`;
    const result = await streamTaskOutput(
      streamUrl,
      inputs.apiKey,
      inputs.timeoutSeconds * 1000,
    );

    const duration = Date.now() - startTime;

    core.setOutput("result", result.status);
    core.setOutput("duration-ms", duration.toString());

    if (result.output) {
      core.setOutput("output", result.output);
    }

    if (result.costUsd !== undefined) {
      core.setOutput("cost-usd", result.costUsd.toString());
    }

    if (result.status === "failed") {
      core.setFailed(`Task failed: ${result.error || "Unknown error"}`);
    } else if (result.status === "timeout") {
      core.setFailed(result.error || "Task timed out");
    } else if (result.status === "unknown") {
      core.warning("Task ended without a terminal status event");
      core.setOutput("result", "unknown");
    } else {
      core.info(`Task completed in ${duration}ms`);
    }
  } catch (error) {
    core.setFailed(getErrorMessage(error));
  }
}
