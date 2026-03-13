#!/usr/bin/env bun

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type {
  IssueCommentEvent,
  PullRequestEvent,
} from "@octokit/webhooks-types";

/**
 * Tests for the VIBECTL_CONTEXT_JSON fallback path in parseGitHubContext().
 *
 * When running outside GitHub Actions, @actions/github context is unavailable.
 * The VIBECTL_CONTEXT_JSON env var provides the context data instead.
 */
describe("parseGitHubContext VIBECTL_CONTEXT_JSON fallback", () => {
  let originalEnv: typeof process.env;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("constructs issue_comment context from VIBECTL_CONTEXT_JSON", () => {
    const payload: Partial<IssueCommentEvent> = {
      action: "created",
      issue: {
        number: 42,
        title: "Test issue",
        body: "Test body",
        pull_request: undefined,
        user: { login: "test-user", id: 123 },
      } as any,
      comment: {
        id: 99999,
        body: "@vibectl review this",
        user: { login: "commenter", id: 456 },
        created_at: "2026-01-01T00:00:00Z",
      } as any,
      repository: {
        name: "test-repo",
        full_name: "test-owner/test-repo",
        owner: { login: "test-owner" },
      } as any,
    };

    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify({
      eventName: "issue_comment",
      payload,
      repo: { owner: "test-owner", repo: "test-repo" },
      actor: "commenter",
    });
    process.env.TRIGGER_PHRASE = "@vibectl";

    const { parseGitHubContext } = require("../../src/github/context");
    const ctx = parseGitHubContext();

    expect(ctx.eventName).toBe("issue_comment");
    expect(ctx.repository.owner).toBe("test-owner");
    expect(ctx.repository.repo).toBe("test-repo");
    expect(ctx.repository.full_name).toBe("test-owner/test-repo");
    expect(ctx.actor).toBe("commenter");
    expect(ctx.eventAction).toBe("created");
    expect(ctx.inputs.triggerPhrase).toBe("@vibectl");
    // Entity context fields
    expect((ctx as any).entityNumber).toBe(42);
    expect((ctx as any).isPR).toBe(false);
  });

  test("constructs pull_request context from VIBECTL_CONTEXT_JSON", () => {
    const payload: Partial<PullRequestEvent> = {
      action: "opened",
      number: 123,
      pull_request: {
        number: 123,
        title: "Test PR",
        body: "PR body",
        user: { login: "pr-author", id: 789 },
      } as any,
      repository: {
        name: "test-repo",
        full_name: "test-owner/test-repo",
        owner: { login: "test-owner" },
      } as any,
    };

    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify({
      eventName: "pull_request",
      payload,
      repo: { owner: "test-owner", repo: "test-repo" },
      actor: "pr-author",
    });

    const { parseGitHubContext } = require("../../src/github/context");
    const ctx = parseGitHubContext();

    expect(ctx.eventName).toBe("pull_request");
    expect(ctx.repository.owner).toBe("test-owner");
    expect((ctx as any).entityNumber).toBe(123);
    expect((ctx as any).isPR).toBe(true);
    expect(ctx.actor).toBe("pr-author");
  });

  test("uses fallback runId when GITHUB_RUN_ID is not set", () => {
    delete process.env.GITHUB_RUN_ID;

    const payload: Partial<IssueCommentEvent> = {
      action: "created",
      issue: { number: 1, pull_request: undefined } as any,
      comment: { id: 1, body: "test" } as any,
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      } as any,
    };

    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify({
      eventName: "issue_comment",
      payload,
      repo: { owner: "owner", repo: "repo" },
      actor: "user",
    });

    const { parseGitHubContext } = require("../../src/github/context");
    const ctx = parseGitHubContext();

    expect(ctx.runId).toBe("0");
  });

  test("reads input env vars (PROMPT, TRIGGER_PHRASE, etc.)", () => {
    const payload: Partial<PullRequestEvent> = {
      action: "opened",
      number: 10,
      pull_request: { number: 10 } as any,
      repository: {
        name: "repo",
        full_name: "owner/repo",
        owner: { login: "owner" },
      } as any,
    };

    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify({
      eventName: "pull_request",
      payload,
      repo: { owner: "owner", repo: "repo" },
      actor: "dev",
    });
    process.env.PROMPT = "Review this PR";
    process.env.TRIGGER_PHRASE = "@vibectl";
    process.env.BRANCH_PREFIX = "vibectl/";

    const { parseGitHubContext } = require("../../src/github/context");
    const ctx = parseGitHubContext();

    expect(ctx.inputs.prompt).toBe("Review this PR");
    expect(ctx.inputs.triggerPhrase).toBe("@vibectl");
    expect(ctx.inputs.branchPrefix).toBe("vibectl/");
  });
});
