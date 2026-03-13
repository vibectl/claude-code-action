/**
 * GitHub-related constants used throughout the application
 *
 * Bot identity is configurable via env vars for non-Actions contexts
 * (e.g., vibectl containers) where a different GitHub App bot is used.
 * CCA defaults are preserved when env vars are not set.
 */

/**
 * Claude App bot user ID — configurable via BOT_USER_ID env var
 */
export const CLAUDE_APP_BOT_ID = Number(
  process.env.BOT_USER_ID ?? "41898282",
);

/**
 * Claude bot username — configurable via BOT_LOGIN env var
 */
export const CLAUDE_BOT_LOGIN = process.env.BOT_LOGIN ?? "claude[bot]";
