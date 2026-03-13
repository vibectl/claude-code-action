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
    delete require.cache[
      require.resolve("../../src/github/constants")
    ];
  });

  test("uses CCA defaults when env vars are not set", async () => {
    delete process.env.BOT_USER_ID;
    delete process.env.BOT_LOGIN;

    // Re-import to pick up env state
    delete require.cache[
      require.resolve("../../src/github/constants")
    ];
    const { CLAUDE_APP_BOT_ID, CLAUDE_BOT_LOGIN } = await import(
      "../../src/github/constants"
    );

    expect(CLAUDE_APP_BOT_ID).toBe(41898282);
    expect(CLAUDE_BOT_LOGIN).toBe("claude[bot]");
  });

  test("reads bot identity from env vars when set", async () => {
    process.env.BOT_USER_ID = "12345678";
    process.env.BOT_LOGIN = "vibectl[bot]";

    delete require.cache[
      require.resolve("../../src/github/constants")
    ];
    const { CLAUDE_APP_BOT_ID, CLAUDE_BOT_LOGIN } = await import(
      "../../src/github/constants"
    );

    expect(CLAUDE_APP_BOT_ID).toBe(12345678);
    expect(CLAUDE_BOT_LOGIN).toBe("vibectl[bot]");
  });
});
