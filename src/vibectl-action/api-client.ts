/**
 * API client for vibectl task submission.
 *
 * Submits tasks to POST /v1/tasks and returns the task ID.
 * Uses native fetch (available in Node 20+).
 */

import * as core from "@actions/core";
import type {
  ActionInputs,
  TaskSubmissionPayload,
  TaskSubmissionResponse,
} from "./types.ts";
import { sanitizeMessage } from "./errors.ts";

/**
 * Build the task submission payload from parsed action inputs.
 */
export function buildTaskPayload(inputs: ActionInputs): TaskSubmissionPayload {
  const payload: TaskSubmissionPayload = {
    type: "exec",
    payload: {
      prompt: inputs.prompt,
      repository: inputs.repository,
      repo_url: inputs.repoUrl || undefined,
      github_token: inputs.githubToken,
      trigger_method: "github_action",
      workflow_name: process.env.GITHUB_WORKFLOW || "",
      workflow_run_id: process.env.GITHUB_RUN_ID || "",
      workflow_event_name: process.env.GITHUB_EVENT_NAME || "",
      workflow_actor: process.env.GITHUB_ACTOR || "",
      max_turns: inputs.maxTurns,
    },
    timeout_seconds: inputs.timeoutSeconds,
  };

  const overrides: TaskSubmissionPayload["pipeline_config_overrides"] = {};
  if (Object.keys(inputs.envVars).length > 0) {
    overrides.env_vars = inputs.envVars;
  }
  if (inputs.egressScanning) {
    overrides.egress_scanning = inputs.egressScanning;
  }
  if (Object.keys(overrides).length > 0) {
    payload.pipeline_config_overrides = overrides;
  }

  return payload;
}

/**
 * Submit a task to the vibectl REST API.
 * Returns the task ID on success, throws on failure.
 */
export async function submitTask(
  inputs: ActionInputs,
): Promise<string> {
  const payload = buildTaskPayload(inputs);
  const url = `${inputs.apiUrl}/v1/tasks`;

  core.debug(`Submitting task to ${url}`);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${inputs.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "vibectl-github-action/1.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    let errorMessage: string;
    try {
      const errorBody = JSON.parse(errorText) as TaskSubmissionResponse;
      errorMessage = errorBody.error || `HTTP ${response.status}`;
    } catch {
      errorMessage = errorText || `HTTP ${response.status}`;
    }
    throw new Error(
      sanitizeMessage(
        `Task submission failed (${response.status}): ${errorMessage}`,
      ),
    );
  }

  const data = (await response.json()) as TaskSubmissionResponse;
  if (!data.task_id) {
    throw new Error("Invalid API response: missing task_id");
  }

  return data.task_id;
}
