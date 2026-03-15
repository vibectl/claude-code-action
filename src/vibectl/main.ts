#!/usr/bin/env bun

/**
 * CLI Entry Point — Invocable target for container dispatch.
 *
 * Reads a task payload from VIBECTL_TASK_PAYLOAD env var, invokes
 * the entry adapter, and outputs structured JSON result to stdout.
 *
 * Runner invocation contract:
 *   VIBECTL_TASK_PAYLOAD env var → bun /opt/cca/src/vibectl/main.ts
 *   → JSON on stdout → exit code 0 (success) or 1 (failure)
 *
 * Error handling: Invalid/missing payloads produce structured error
 * JSON on stdout (never unhandled exceptions). This ensures the
 * runner worker always receives parseable output.
 */

import { executeTask } from "./entry-adapter.ts";
import type { TaskPayload, AdapterResult } from "./entry-adapter.ts";

/**
 * Parse and validate the task payload from environment.
 *
 * Exported for testability. Returns the parsed payload or an error result.
 */
export function parsePayload(): TaskPayload | AdapterResult {
  const payloadRaw = process.env.VIBECTL_TASK_PAYLOAD;
  if (!payloadRaw) {
    return {
      success: false,
      mode: "agent",
      error: "VIBECTL_TASK_PAYLOAD environment variable is not set",
    };
  }

  try {
    return JSON.parse(payloadRaw) as TaskPayload;
  } catch (parseError) {
    const detail =
      parseError instanceof Error ? parseError.message : String(parseError);
    return {
      success: false,
      mode: "agent",
      error: `Failed to parse VIBECTL_TASK_PAYLOAD: ${detail}`,
    };
  }
}

/** Type guard: distinguishes error results from valid payloads */
function isErrorResult(
  value: TaskPayload | AdapterResult,
): value is AdapterResult {
  return "success" in value && (value as AdapterResult).success === false;
}

// Auto-execute when run as CLI entry point (not when imported for testing)
if (import.meta.main) {
  (async () => {
    let result: AdapterResult;

    try {
      const parsed = parsePayload();
      if (isErrorResult(parsed)) {
        result = parsed;
      } else {
        result = await executeTask(parsed);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result = {
        success: false,
        mode: "agent",
        error: `CLI execution failed: ${detail}`,
      };
    }

    // Write result JSON and add explicit newline delimiter so the runner's
    // backward line-scan in parseAdapterResult() always sees the result as a
    // complete, standalone line — even when prior console.log/core.info output
    // from CCA or @actions/core shares stdout.
    const json = JSON.stringify(result) + "\n";

    // Flush stdout before exiting.  process.exit() can terminate before the
    // write buffer drains (observed in container sandbox pipes), which would
    // cause the runner to see empty or truncated stdout.  Writing into a
    // callback guarantees the kernel buffer has accepted the data before we
    // set the exit code.  If the write itself errors we still exit to avoid
    // the process hanging.
    process.stdout.write(json, () => {
      process.exit(result.success ? 0 : 1);
    });

    // Safety: if the callback is never invoked (e.g., broken pipe), exit
    // after a generous grace period so the container is not left alive.
    setTimeout(() => process.exit(result.success ? 0 : 1), 5000);
  })();
}
