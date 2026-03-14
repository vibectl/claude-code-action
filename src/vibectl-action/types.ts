/**
 * Type definitions for the vibectl GitHub Action.
 *
 * These types define the contracts between modules: action inputs,
 * API request/response shapes, SSE event parsing, and action outputs.
 */

/** Parsed action inputs ready for API submission. */
export interface ActionInputs {
  apiKey: string;
  prompt: string;
  apiUrl: string;
  timeoutSeconds: number;
  envVars: Record<string, string>;
  maxTurns: number | undefined;
  repository: string;
  repoUrl: string;
  githubToken: string;
  egressScanning: string | undefined;
}

/** Task submission request body sent to POST /v1/tasks. */
export interface TaskSubmissionPayload {
  type: "exec";
  payload: {
    prompt: string;
    repository: string;
    repo_url: string | undefined;
    github_token: string;
    trigger_method: "github_action";
    workflow_name: string;
    workflow_run_id: string;
    workflow_event_name: string;
    workflow_actor: string;
    max_turns: number | undefined;
  };
  timeout_seconds: number;
  pipeline_config_overrides?: {
    env_vars?: Record<string, string>;
    egress_scanning?: string;
  };
}

/** Response from POST /v1/tasks. */
export interface TaskSubmissionResponse {
  task_id?: string;
  status?: string;
  error?: string;
}

/** Parsed SSE event data from the streaming endpoint. */
export interface SSEEventData {
  data?: string;
  type?: string;
  costUsd?: number;
  error?: string;
  exitCode?: number;
  timestamp?: number;
}

/** Mutable state accumulated while parsing an SSE stream. */
export interface StreamState {
  outputBuffer: string;
  status: string;
  error: string | null;
  costUsd: number | undefined;
  exitCode: number | undefined;
}

/** Final result from streaming task output. */
export interface StreamResult {
  status: string;
  output?: string;
  costUsd?: number;
  error?: string | null;
  exitCode?: number;
}

/** Action output values set via core.setOutput(). */
export interface ActionOutputs {
  result: string;
  taskId: string;
  durationMs: string;
  costUsd?: string;
  output?: string;
}
