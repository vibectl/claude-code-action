#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("collectActionInputsPresence fallback", () => {
  let originalEnv: typeof process.env;
  let tempConfigPath: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    tempConfigPath = join(tmpdir(), `vibectl-test-config-${Date.now()}.json`);
  });

  afterEach(() => {
    process.env = originalEnv;
    try {
      unlinkSync(tempConfigPath);
    } catch {
      // File may not exist
    }
  });

  test("returns defaults when ALL_INPUTS and VIBECTL_TASK_CONFIG are absent", () => {
    delete process.env.ALL_INPUTS;
    delete process.env.VIBECTL_TASK_CONFIG;

    const {
      collectActionInputsPresence,
    } = require("../../src/entrypoints/collect-inputs");
    const result = collectActionInputsPresence();

    expect(result).toBe(JSON.stringify({}));
  });

  test("reads from ALL_INPUTS when set (original behavior)", () => {
    process.env.ALL_INPUTS = JSON.stringify({
      trigger_phrase: "@vibectl",
      mode: "agent",
    });
    delete process.env.VIBECTL_TASK_CONFIG;

    const {
      collectActionInputsPresence,
    } = require("../../src/entrypoints/collect-inputs");
    const result = JSON.parse(collectActionInputsPresence());

    // trigger_phrase differs from default "@claude" -> true
    expect(result.trigger_phrase).toBe(true);
    // mode differs from default "tag" -> true
    expect(result.mode).toBe(true);
  });

  test("reads from VIBECTL_TASK_CONFIG file when ALL_INPUTS is absent", () => {
    delete process.env.ALL_INPUTS;

    const taskConfig = {
      trigger_phrase: "@vibectl",
      mode: "agent",
      branch_prefix: "vibectl/",
    };
    writeFileSync(tempConfigPath, JSON.stringify(taskConfig));
    process.env.VIBECTL_TASK_CONFIG = tempConfigPath;

    const {
      collectActionInputsPresence,
    } = require("../../src/entrypoints/collect-inputs");
    const result = JSON.parse(collectActionInputsPresence());

    expect(result.trigger_phrase).toBe(true); // differs from default "@claude"
    expect(result.mode).toBe(true); // differs from default "tag"
    expect(result.branch_prefix).toBe(true); // differs from default "claude/"
  });

  test("ALL_INPUTS takes precedence over VIBECTL_TASK_CONFIG", () => {
    process.env.ALL_INPUTS = JSON.stringify({
      trigger_phrase: "@override",
    });

    const taskConfig = { trigger_phrase: "@vibectl" };
    writeFileSync(tempConfigPath, JSON.stringify(taskConfig));
    process.env.VIBECTL_TASK_CONFIG = tempConfigPath;

    const {
      collectActionInputsPresence,
    } = require("../../src/entrypoints/collect-inputs");
    const result = JSON.parse(collectActionInputsPresence());

    // Should use ALL_INPUTS value, not config file
    expect(result.trigger_phrase).toBe(true);
  });

  test("handles non-existent VIBECTL_TASK_CONFIG path gracefully", () => {
    delete process.env.ALL_INPUTS;
    process.env.VIBECTL_TASK_CONFIG = "/nonexistent/path/config.json";

    const {
      collectActionInputsPresence,
    } = require("../../src/entrypoints/collect-inputs");
    const result = collectActionInputsPresence();

    expect(result).toBe(JSON.stringify({}));
  });
});
