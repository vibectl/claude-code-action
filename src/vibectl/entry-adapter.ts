#!/usr/bin/env bun

/**
 * Entry Adapter — Orchestrates CCA execution from a vibectl task payload.
 *
 * Bridges vibectl's container-based task dispatch to CCA's internal
 * execution flow. Recomposes run.ts orchestration from internal imports
 * so that run.ts and token.ts remain untouched (zero diff, zero merge
 * conflict risk on upstream sync).
 *
 * Execution flow:
 * 1. Parse task payload from environment
 * 2. Configure auth (auth-bridge)
 * 3. Construct GitHub context (Phase 2 patch: VIBECTL_CONTEXT_JSON)
 * 4. Detect mode (tag/agent)
 * 5. Invoke CCA prepare (tag or agent mode)
 * 6. Invoke CCA run (SDK execution)
 * 7. Scan output for secrets (output-scanner)
 * 8. Return result
 */

import { writeFile, readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { configureAuth } from "./auth-bridge.ts";
import { scanForSecrets } from "./output-scanner.ts";
import type { TaskCredentials } from "./auth-bridge.ts";
import type { ScanResult } from "./output-scanner.ts";

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
import { preparePrompt } from "../../base-action/src/prepare-prompt.ts";
import { runClaude } from "../../base-action/src/run-claude.ts";
import { collectActionInputsPresence } from "../entrypoints/collect-inputs.ts";
import type { ClaudeRunResult } from "../../base-action/src/run-claude-sdk.ts";

/**
 * Task payload from vibectl runner worker.
 *
 * Contains everything needed to execute a CCA task:
 * credentials, context, and configuration.
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
 * Result of adapter execution.
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
  /** Output scan results */
  scanResult?: ScanResult;
  /** Error message (if failed) */
  error?: string;
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
      const hasWritePermissions = await checkWritePermissions(
        octokit.rest,
        context,
        context.inputs.allowedNonWriteUsers,
        true, // Override token is always present in vibectl (installation token)
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

    const promptFile = `${tempDir}/claude-prompts/claude-prompt.txt`;
    await mkdir(`${tempDir}/claude-prompts`, { recursive: true });

    const promptConfig = await preparePrompt({
      prompt: "",
      promptFile,
    });

    const claudeResult: ClaudeRunResult = await runClaude(promptConfig.path, {
      claudeArgs: prepareResult.claudeArgs,
      appendSystemPrompt: process.env.APPEND_SYSTEM_PROMPT,
      model: process.env.ANTHROPIC_MODEL,
    });

    // Stage: scan — Scan output for secrets (post-execution, per OD-4)
    stage = "scan";
    let scanResult: ScanResult | undefined;
    if (claudeResult.executionFile && existsSync(claudeResult.executionFile)) {
      const outputContent = await readFile(claudeResult.executionFile, "utf-8");
      scanResult = scanForSecrets(outputContent);
    }

    return {
      success: claudeResult.conclusion === "success",
      mode,
      executionFile: claudeResult.executionFile,
      sessionId: claudeResult.sessionId,
      scanResult,
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
