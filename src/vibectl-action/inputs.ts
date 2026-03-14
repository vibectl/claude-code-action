/**
 * Action input parsing and validation.
 *
 * Reads inputs from the GitHub Actions runtime via @actions/core,
 * validates required fields, and returns a typed ActionInputs object.
 */

import * as core from "@actions/core";
import type { ActionInputs } from "./types.ts";

/**
 * Parse multiline KEY=VALUE input into a record.
 * Skips blank lines, comments (lines starting with #), and lines without '='.
 */
export function parseEnvInput(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!raw.trim()) return result;

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.substring(0, eqIndex);
    const value = trimmed.substring(eqIndex + 1);
    result[key] = value;
  }
  return result;
}

/**
 * Parse and validate all action inputs.
 * Masks the API key immediately to prevent accidental log exposure.
 */
export function getInputs(): ActionInputs {
  const apiKey = core.getInput("api-key", { required: true });
  if (!apiKey) {
    throw new Error("Input 'api-key' is required but was not provided");
  }
  core.setSecret(apiKey);

  const prompt = core.getInput("prompt", { required: true });
  if (!prompt) {
    throw new Error("Input 'prompt' is required but was not provided");
  }

  const apiUrl =
    core.getInput("api-url", { required: false }) || "https://api.vibectl.dev";
  const timeoutStr =
    core.getInput("timeout", { required: false }) || "1800";
  const timeoutSeconds = parseInt(timeoutStr, 10);
  if (isNaN(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`Invalid timeout value: '${timeoutStr}' (must be a positive integer)`);
  }

  const envRaw = core.getInput("env", { required: false }) || "";
  const envVars = parseEnvInput(envRaw);

  const maxTurnsStr = core.getInput("max-turns", { required: false });
  let maxTurns: number | undefined;
  if (maxTurnsStr) {
    maxTurns = parseInt(maxTurnsStr, 10);
    if (isNaN(maxTurns) || maxTurns <= 0) {
      throw new Error(`Invalid max-turns value: '${maxTurnsStr}' (must be a positive integer)`);
    }
  }

  const egressScanningRaw = core.getInput("egress-scanning", { required: false });
  let egressScanning: string | undefined;
  if (egressScanningRaw) {
    if (egressScanningRaw !== "full" && egressScanningRaw !== "relay") {
      throw new Error(`Invalid egress-scanning value: '${egressScanningRaw}' (must be 'full' or 'relay')`);
    }
    egressScanning = egressScanningRaw;
  }

  const repository = process.env.GITHUB_REPOSITORY || "";
  const githubToken = process.env.GITHUB_TOKEN || "";
  if (githubToken) {
    core.setSecret(githubToken);
  }

  const repoUrl = repository ? `https://github.com/${repository}` : "";

  return {
    apiKey,
    prompt,
    apiUrl,
    timeoutSeconds,
    envVars,
    maxTurns,
    repository,
    repoUrl,
    githubToken,
    egressScanning,
  };
}
