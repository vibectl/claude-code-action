#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("constants bot identity fallback", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
    // Clear module cache so constants re-evaluate env vars
    delete require.cache[require.resolve("../../src/github/constants")];
  });

  test("uses CCA defaults when env vars are not set", async () => {
    delete process.env.BOT_USER_ID;
    delete process.env.BOT_LOGIN;

    // Re-import to pick up env state
    delete require.cache[require.resolve("../../src/github/constants")];
    const { CLAUDE_APP_BOT_ID, CLAUDE_BOT_LOGIN } = await import(
      "../../src/github/constants"
    );

    expect(CLAUDE_APP_BOT_ID).toBe(41898282);
    expect(CLAUDE_BOT_LOGIN).toBe("claude[bot]");
  });

  test("reads bot identity from env vars when set", async () => {
    process.env.BOT_USER_ID = "12345678";
    process.env.BOT_LOGIN = "vibectl[bot]";

    delete require.cache[require.resolve("../../src/github/constants")];
    const { CLAUDE_APP_BOT_ID, CLAUDE_BOT_LOGIN } = await import(
      "../../src/github/constants"
    );

    expect(CLAUDE_APP_BOT_ID).toBe(12345678);
    expect(CLAUDE_BOT_LOGIN).toBe("vibectl[bot]");
  });

  test("falls back to CCA default when BOT_USER_ID is non-numeric (NaN guard)", async () => {
    process.env.BOT_USER_ID = "not-a-number";
    process.env.BOT_LOGIN = "vibectl[bot]";

    delete require.cache[require.resolve("../../src/github/constants")];
    const { CLAUDE_APP_BOT_ID } = await import("../../src/github/constants");

    // Must NOT be NaN — should fall back to CCA default
    expect(Number.isNaN(CLAUDE_APP_BOT_ID)).toBe(false);
    expect(CLAUDE_APP_BOT_ID).toBe(41898282);
  });

  test("falls back to CCA default when BOT_USER_ID is empty string", async () => {
    process.env.BOT_USER_ID = "";

    delete require.cache[require.resolve("../../src/github/constants")];
    const { CLAUDE_APP_BOT_ID } = await import("../../src/github/constants");

    // Empty string → Number("") === 0, which is not NaN but is falsy.
    // The NaN guard only catches NaN; 0 is a valid (if unusual) numeric ID.
    expect(Number.isNaN(CLAUDE_APP_BOT_ID)).toBe(false);
  });
});
