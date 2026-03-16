#!/usr/bin/env bun

/**
 * Entry Adapter — Orchestrates CCA execution from a vibectl task payload.
 *
 * Bridges vibectl's container-based task dispatch to CCA's internal
 * execution flow. Recomposes run.ts orchestration from internal imports
 * so that run.ts and token.ts remain untouched (zero diff, zero merge
 * conflict risk on upstream sync).
 *
 * Architecture: Preserves the Cloudflare-native execution model
 * (queue -> container -> AI proxy) by recomposing CCA's orchestration
 * through direct imports rather than modifying CCA's entry points.
 *
 * Execution flow:
 * 1. Parse task payload from environment
 * 2. Configure auth (auth-bridge)
 * 3. Construct GitHub context (Phase 2 patch: VIBECTL_CONTEXT_JSON)
 * 4. Detect mode (tag/agent)
 * 5. Invoke CCA prepare (tag or agent mode)
 * 6. Invoke CCA run (SDK execution)
 * 7. Return result
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { configureAuth } from "./auth-bridge.ts";
import type { TaskCredentials } from "./auth-bridge.ts";

// CCA internal imports — reusing existing modules without modification
import { parseGitHubContext, isEntityContext } from "../github/context.ts";
import type { GitHubContext } from "../github/context.ts";
import { detectMode } from "../modes/detector.ts";
import { prepareTagMode } from "../modes/tag/index.ts";
import { prepareAgentMode } from "../modes/agent/index.ts";
import { createOctokit } from "../github/api/client.ts";
import { checkWritePermissions } from "../github/validation/permissions.ts";
import { checkContainsTrigger } from "../github/validation/trigger.ts";
import { validateEnvironmentVariables } from "../../base-action/src/validate-env.ts";
import { setupClaudeCodeSettings } from "../../base-action/src/setup-claude-code-settings.ts";
import { installPlugins } from "../../base-action/src/install-plugins.ts";
import { preparePrompt } from "../../base-action/src/prepare-prompt.ts";
import { runClaude } from "../../base-action/src/run-claude.ts";
import { collectActionInputsPresence } from "../entrypoints/collect-inputs.ts";
import type { ClaudeRunResult } from "../../base-action/src/run-claude-sdk.ts";

/**
 * Task payload from vibectl runner worker.
 *
 * Contains everything needed to execute a CCA task:
 * credentials, context, and configuration.
 *
 * EP152 contract: Runner worker constructs this payload and passes it
 * to the container via environment/stdin. Changes to this interface
 * require coordinated updates in the backend runner worker.
 */
export interface TaskPayload {
  /** Authentication credentials */
  credentials: TaskCredentials;
  /** GitHub context JSON (sets VIBECTL_CONTEXT_JSON) */
  contextJson: {
    eventName: string;
    payload: Record<string, unknown>;
    repo: { owner: string; repo: string };
    actor: string;
  };
  /** Task configuration inputs (written to VIBECTL_TASK_CONFIG file) */
  taskConfig?: Record<string, string>;
  /** Custom prompt (optional — tag mode uses auto-generated prompt) */
  prompt?: string;
}

/**
 * Execution metrics from the Claude Agent SDK.
 *
 * Extracted from SDKResultMessage after CCA execution completes.
 * All fields optional — metrics may be absent if execution fails
 * before the SDK produces a result message.
 */
export interface AdapterMetrics {
  /** Number of conversation turns used */
  numTurns?: number;
  /** Total cost in USD */
  totalCostUsd?: number;
  /** Execution duration in milliseconds (SDK-measured) */
  durationMs?: number;
  /** Count of permission denial events during execution */
  permissionDenialsCount?: number;
}

/**
 * Result of adapter execution.
 *
 * Contract: Runner worker reads this result from the container's
 * stdout/exit. Changes require coordinated backend updates.
 */
export interface AdapterResult {
  /** Whether CCA execution succeeded */
  success: boolean;
  /** Detected execution mode */
  mode: "tag" | "agent";
  /** Path to execution output file (if any) */
  executionFile?: string;
  /** SDK session ID (if any) */
  sessionId?: string;
  /** Error message (if failed) */
  error?: string;
  /** Execution metrics from the Claude Agent SDK (present on successful execution) */
  metrics?: AdapterMetrics;
}

/**
 * Extract execution metrics from the SDK execution file.
 *
 * The upstream runClaudeWithSdk() writes all SDK messages to an execution
 * file as a JSON array. The result message (type: "result") contains
 * metrics that are logged to console but not returned in ClaudeRunResult.
 * This function reads the execution file and extracts those metrics
 * without modifying any upstream files.
 *
 * @param executionFile - Path to the SDK execution output file
 * @returns Extracted metrics, or undefined if extraction fails
 */
async function extractMetricsFromExecutionFile(
  executionFile: string,
): Promise<AdapterMetrics | undefined> {
  try {
    const content = await readFile(executionFile, "utf-8");
    const messages: unknown[] = JSON.parse(content);

    // Find the result message (last message with type "result")
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (
        typeof msg === "object" &&
        msg !== null &&
        "type" in msg &&
        (msg as Record<string, unknown>).type === "result"
      ) {
        const resultMsg = msg as Record<string, unknown>;
        const metrics: AdapterMetrics = {};

        if (typeof resultMsg.num_turns === "number") {
          metrics.numTurns = resultMsg.num_turns;
        }
        if (typeof resultMsg.total_cost_usd === "number") {
          metrics.totalCostUsd = resultMsg.total_cost_usd;
        }
        if (typeof resultMsg.duration_ms === "number") {
          metrics.durationMs = resultMsg.duration_ms;
        }
        if (Array.isArray(resultMsg.permission_denials)) {
          metrics.permissionDenialsCount = resultMsg.permission_denials.length;
        }

        return metrics;
      }
    }
    return undefined;
  } catch {
    // Execution file may not exist or be unreadable — metrics are optional
    return undefined;
  }
}

/**
 * Execute a CCA task from a vibectl task payload.
 *
 * This is the primary entry point for container-based CCA execution.
 * It orchestrates the same CCA internal functions that run.ts calls,
 * but with vibectl's auth model and lifecycle.
 */
export async function executeTask(
  payload: TaskPayload,
): Promise<AdapterResult> {
  let context: GitHubContext | undefined;
  let mode: "tag" | "agent" = "agent";
  let stage = "init";

  try {
    // Stage: auth — Configure authentication and environment
    stage = "auth";
    const { tempDir } = await configureAuth(payload.credentials);

    // Stage: context — Set GitHub context for Phase 2 patch (context.ts getRawContext())
    stage = "context";
    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify(payload.contextJson);

    // Write task config file for Phase 2 patch (collect-inputs.ts)
    if (payload.taskConfig) {
      const configPath = `${tempDir}/task-config.json`;
      await writeFile(configPath, JSON.stringify(payload.taskConfig));
      process.env.VIBECTL_TASK_CONFIG = configPath;
    }

    // Set prompt if provided
    if (payload.prompt) {
      process.env.PROMPT = payload.prompt;
    }

    // Stage: prepare — Invoke CCA Phase 1 (mode detection, permissions, trigger check)
    stage = "prepare";
    const actionInputsPresent = collectActionInputsPresence();
    context = parseGitHubContext();
    mode = detectMode(context);

    const githubToken = payload.credentials.githubToken;
    const octokit = createOctokit(githubToken);

    // Permission check (entity contexts only)
    if (isEntityContext(context)) {
      // Permission override is `true` because vibectl always provides a GitHub
      // installation token (ghs_xxx) via the auth bridge, which has repo-level
      // write permissions granted by the App installation. In CCA's GitHub
      // Actions context, this parameter indicates whether a separate override
      // token (PAT) was provided; in vibectl's model, the installation token
      // inherently has the override capability, so it is always present.
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        true,
      );
      if (!hasWritePermissions) {
        return {
          success: false,
          mode,
          error: `[prepare] Actor does not have write permissions to the repository`,
        };
      }
    }

    // Trigger check
    const containsTrigger =
      mode === "tag"
        ? isEntityContext(context) && checkContainsTrigger(context)
        : !!context.inputs?.prompt;

    if (!containsTrigger) {
      return {
        success: true,
        mode,
        // No trigger found — this is a valid outcome (task skipped)
      };
    }

    // Prepare mode-specific context
    const prepareResult =
      mode === "tag"
        ? await prepareTagMode({ context, octokit, githubToken })
        : await prepareAgentMode({ context, octokit, githubToken });

    // Stage: execute — Invoke CCA Phase 3 (Run Claude)
    stage = "execute";
    process.env.INPUT_ACTION_INPUTS_PRESENT = actionInputsPresent;
    process.env.CLAUDE_CODE_ACTION = "1";
    process.env.DETAILED_PERMISSION_MESSAGES = "1";

    validateEnvironmentVariables();

    await setupClaudeCodeSettings(process.env.INPUT_SETTINGS);

    // Install user-specified plugins and marketplace registries (matches run.ts).
    // No-op when INPUT_PLUGIN_MARKETPLACES and INPUT_PLUGINS are unset.
    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
    );

    const promptFile = `${tempDir}/claude-prompts/claude-prompt.txt`;
    await mkdir(`${tempDir}/claude-prompts`, { recursive: true });

    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });

    // runClaude() parameter omissions (compared to CCA's run.ts):
    //
    // - pathToClaudeCodeExecutable: Omitted because vibectl uses the Claude
    //   Code SDK directly (via ANTHROPIC_BASE_URL pointing to the AI proxy),
    //   not a CLI executable on PATH. The SDK is the canonical execution method
    //   in the container environment.
    //
    // - showFullOutput: Omitted because vibectl captures execution output
    //   programmatically via the executionFile and sessionId return values,
    //   not via GitHub Actions step summary UI. Output display is handled
    //   by the platform (EP152: runner worker reads container output).
    const claudeResult: ClaudeRunResult = await runClaude(promptConfig.path, {
      claudeArgs: prepareResult.claudeArgs,
      appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
      model: process.env.ANTHROPIC_MODEL,
    });

    // Extract execution metrics from the SDK execution file.
    // The upstream SDK writes all messages to this file; we read back the
    // result message to capture metrics without modifying upstream files.
    const metrics = claudeResult.executionFile
      ? await extractMetricsFromExecutionFile(claudeResult.executionFile)
      : undefined;

    return {
      success: claudeResult.conclusion === "success",
      mode,
      executionFile: claudeResult.executionFile,
      sessionId: claudeResult.sessionId,
      metrics,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      mode,
      error: `[${stage}] ${detail}`,
    };
  }
}
