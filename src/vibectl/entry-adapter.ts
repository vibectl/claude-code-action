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
 * Two execution paths:
 *
 * Webhook-triggered (contextJson present):
 *   1. Parse task payload from environment
 *   2. Configure auth (auth-bridge: GitHub + AI proxy)
 *   3. Construct GitHub context (VIBECTL_CONTEXT_JSON)
 *   4. Detect mode (tag/agent)
 *   5. Invoke CCA prepare (tag or agent mode)
 *   6. Invoke CCA run (SDK execution)
 *   7. Return result
 *
 * Prompt-only (contextJson absent):
 *   1. Parse task payload from environment
 *   2. Configure auth (prompt-only: AI proxy only)
 *   3. Write prompt to file
 *   4. Invoke CCA run (SDK execution)
 *   5. Return result
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { configureAuth, configurePromptOnlyAuth } from "./auth-bridge.ts";
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
  /**
   * GitHub context JSON (sets VIBECTL_CONTEXT_JSON).
   * Optional — when absent, the adapter uses prompt-only execution
   * which bypasses all GitHub API calls and webhook processing.
   */
  contextJson?: {
    eventName: string;
    payload: Record<string, unknown>;
    repo: { owner: string; repo: string };
    actor: string;
  };
  /** Task configuration inputs (written to VIBECTL_TASK_CONFIG file) */
  taskConfig?: Record<string, string>;
  /** Custom prompt (optional for webhook mode, required for prompt-only mode) */
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
 * Prompt-only execution path.
 *
 * Bypasses all GitHub-specific logic (context parsing, mode detection,
 * permission checks, actor validation) and goes directly to the Agent
 * SDK with a plain prompt. No Octokit is created, no GitHub API calls
 * are made, and no webhook payload structures are needed.
 *
 * @param payload - Task payload with prompt but no contextJson
 * @returns AdapterResult with mode "agent"
 */
async function executePromptOnly(
  payload: TaskPayload,
): Promise<AdapterResult> {
  let stage = "init";

  try {
    // Validate prompt presence — required for prompt-only mode
    if (!payload.prompt || payload.prompt.trim().length === 0) {
      return {
        success: false,
        mode: "agent",
        error: "[prepare] prompt is required for prompt-only execution (no contextJson provided)",
      };
    }

    // Stage: auth — Configure minimal environment (AI proxy only, no GitHub)
    stage = "auth";
    const { tempDir } = await configurePromptOnlyAuth(payload.credentials);

    // Write task config if provided
    if (payload.taskConfig) {
      const configPath = `${tempDir}/task-config.json`;
      await writeFile(configPath, JSON.stringify(payload.taskConfig));
      process.env.VIBECTL_TASK_CONFIG = configPath;
    }

    // Stage: execute — Run Claude via Agent SDK with prompt
    stage = "execute";
    process.env.CLAUDE_CODE_ACTION = "1";

    validateEnvironmentVariables();

    await setupClaudeCodeSettings(process.env.INPUT_SETTINGS);

    await installPlugins(
      process.env.INPUT_PLUGIN_MARKETPLACES,
      process.env.INPUT_PLUGINS,
    );

    // Write prompt to file for the SDK
    const promptDir = `${tempDir}/claude-prompts`;
    await mkdir(promptDir, { recursive: true });
    const promptFile = `${promptDir}/claude-prompt.txt`;
    await writeFile(promptFile, payload.prompt);

    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });

    const claudeResult: ClaudeRunResult = await runClaude(promptConfig.path, {
      appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
      model: process.env.ANTHROPIC_MODEL,
    });

    const metrics = claudeResult.executionFile
      ? await extractMetricsFromExecutionFile(claudeResult.executionFile)
      : undefined;

    return {
      success: claudeResult.conclusion === "success",
      mode: "agent",
      executionFile: claudeResult.executionFile,
      sessionId: claudeResult.sessionId,
      metrics,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      mode: "agent",
      error: `[${stage}] ${detail}`,
    };
  }
}

/**
 * Execute a CCA task from a vibectl task payload.
 *
 * This is the primary entry point for container-based CCA execution.
 * Routes to either prompt-only execution (no GitHub context) or
 * webhook-triggered execution (full GitHub flow).
 */
export async function executeTask(
  payload: TaskPayload,
): Promise<AdapterResult> {
  // Route: prompt-only execution when no contextJson is provided
  if (!payload.contextJson) {
    return executePromptOnly(payload);
  }

  // Route: webhook-triggered execution with full GitHub context
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

    const githubToken = payload.credentials.githubToken!;
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
