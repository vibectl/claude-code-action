/**
 * Error handling and secret masking utilities.
 *
 * Ensures API keys, tokens, and other sensitive values
 * are never exposed in workflow logs or error messages.
 */

/** Patterns that indicate sensitive content in error messages. */
const SENSITIVE_PATTERNS = [
  /Bearer\s+[^\s"']+/gi,
  /vibe_[a-zA-Z0-9_-]+/gi,
  /ghs_[a-zA-Z0-9]+/gi,
  /ghp_[a-zA-Z0-9]+/gi,
  /github_pat_[a-zA-Z0-9_]+/gi,
  /sk-[a-zA-Z0-9_-]{20,}/gi,
  /Authorization:\s*[^\s"']+/gi,
];

/**
 * Sanitize a message by replacing known sensitive patterns with redacted placeholders.
 * Applied to error messages before they are logged or set as failure reasons.
 */
export function sanitizeMessage(message: string): string {
  let sanitized = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, "***");
  }
  return sanitized;
}

/**
 * Extract a safe error message from an unknown error value.
 * Sanitizes the message to prevent credential leakage.
 */
export function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeMessage(raw);
}
