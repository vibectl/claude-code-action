#!/usr/bin/env bun

/**
 * Container integration test -- validates the vibectl execution chain
 * inside a built container image.
 *
 * Exercises the full entry adapter -> auth bridge -> CCA internals flow
 * with a mock task payload. Validates that:
 *
 * 1. Entry adapter accepts a mock task payload
 * 2. Auth bridge configures the container environment
 * 3. CCA's context parsing uses VIBECTL_CONTEXT_JSON (Phase 2 patch)
 * 4. CCA's mode detection runs on the constructed context
 * 5. CCA's execution chain is invoked (prepare phase reached)
 * 6. Output scanner processes text for secrets
 *
 * The test expects the GitHub API call (permission check) to fail
 * because the container has no live GitHub API access. This failure
 * is the proof that the chain executed through all vibectl integration
 * layers and reached CCA's internal code paths.
 *
 * Exit 0 = all checks pass. Non-zero = failure with diagnostic output.
 */

import { existsSync } from "fs";

const CCA_ROOT = "/opt/cca";

let passed = 0;
let failed = 0;

async function check(
  name: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  FAIL  ${name}: ${message}`);
    failed++;
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

console.log("CCA Container Integration Test");
console.log("===============================\n");

// Save original env to restore between tests
const originalEnv = { ...process.env };

function restoreEnv(): void {
  // Remove any env vars set during tests
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  // Restore original values
  Object.assign(process.env, originalEnv);
}

// --- 1. Auth Bridge Validation ---
console.log("[Auth Bridge]");

await check(
  "configureAuth sets environment variables from credentials",
  async () => {
    restoreEnv();

    const { configureAuth } = await import(
      `${CCA_ROOT}/src/vibectl/auth-bridge.ts`
    );

    const credentials = {
      githubToken: "ghs_integration_test_token_placeholder_x",
      aiProxyUrl: "https://ai-proxy.test.vibectl.dev/v1/proxy/cust_test",
      proxyHeaders: { "X-Proxy-Token": "test-proxy-hmac-value" },
      repoOwner: "test-org",
      repoName: "test-repo",
      eventName: "issue_comment",
      botUserId: "123456",
      botLogin: "vibectl-test[bot]",
    };

    const { tempDir } = await configureAuth(credentials);

    // Verify auth bridge configured all expected env vars
    assert(
      process.env.GITHUB_TOKEN === credentials.githubToken,
      `GITHUB_TOKEN not set (got: ${process.env.GITHUB_TOKEN})`,
    );
    assert(
      process.env.ANTHROPIC_BASE_URL === credentials.aiProxyUrl,
      `ANTHROPIC_BASE_URL not set (got: ${process.env.ANTHROPIC_BASE_URL})`,
    );
    assert(
      process.env.ANTHROPIC_API_KEY === "dummy-key-replaced-by-ai-proxy",
      `ANTHROPIC_API_KEY not set to dummy value`,
    );
    assert(
      process.env.BOT_USER_ID === "123456",
      `BOT_USER_ID not set (got: ${process.env.BOT_USER_ID})`,
    );
    assert(
      process.env.BOT_LOGIN === "vibectl-test[bot]",
      `BOT_LOGIN not set (got: ${process.env.BOT_LOGIN})`,
    );
    assert(
      process.env.GITHUB_ACTION_PATH === "/opt/cca",
      `GITHUB_ACTION_PATH not set to /opt/cca`,
    );

    // Verify temp dir was created with output files
    assert(existsSync(tempDir), `Temp dir not created: ${tempDir}`);
    assert(
      existsSync(process.env.GITHUB_OUTPUT!),
      "GITHUB_OUTPUT file not created",
    );
    assert(existsSync(process.env.GITHUB_ENV!), "GITHUB_ENV file not created");

    console.log(`         Temp dir: ${tempDir}`);
    console.log(`         All env vars configured correctly`);
  },
);

// --- 2. Context Parsing Validation ---
console.log("\n[Context Parsing]");

await check(
  "parseGitHubContext reads VIBECTL_CONTEXT_JSON (Phase 2 patch)",
  async () => {
    restoreEnv();

    // Set VIBECTL_CONTEXT_JSON before importing context parser
    const contextJson = {
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: {
          number: 42,
          title: "Test issue for integration",
          body: "Issue body text",
          pull_request: undefined,
          user: { login: "test-actor", id: 100 },
        },
        comment: {
          id: 1,
          body: "@vibectl review this code",
          user: { login: "test-actor", id: 100 },
          created_at: "2026-01-01T00:00:00Z",
        },
        repository: {
          name: "test-repo",
          full_name: "test-org/test-repo",
          owner: { login: "test-org" },
        },
      },
      repo: { owner: "test-org", repo: "test-repo" },
      actor: "test-actor",
    };
    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify(contextJson);
    process.env.TRIGGER_PHRASE = "@vibectl";

    const { parseGitHubContext, isEntityContext } = await import(
      `${CCA_ROOT}/src/github/context.ts`
    );

    const context = parseGitHubContext();

    // Verify context was parsed from VIBECTL_CONTEXT_JSON
    assert(
      context.eventName === "issue_comment",
      `Event name: expected issue_comment, got ${context.eventName}`,
    );
    assert(
      context.repository.owner === "test-org",
      `Repo owner: expected test-org, got ${context.repository.owner}`,
    );
    assert(
      context.actor === "test-actor",
      `Actor: expected test-actor, got ${context.actor}`,
    );
    assert(
      isEntityContext(context),
      "Context should be recognized as entity context",
    );

    console.log(`         Event: ${context.eventName}`);
    console.log(
      `         Repo: ${context.repository.owner}/${context.repository.repo}`,
    );
    console.log(`         Actor: ${context.actor}`);
  },
);

// --- 3. Mode Detection Validation ---
console.log("\n[Mode Detection]");

await check(
  "detectMode correctly identifies tag mode for issue_comment with trigger",
  async () => {
    restoreEnv();

    // Set up context for mode detection
    const contextJson = {
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: {
          number: 42,
          title: "Test issue",
          body: "Issue body",
          pull_request: undefined,
          user: { login: "test-actor", id: 100 },
        },
        comment: {
          id: 1,
          body: "@vibectl review this code",
          user: { login: "test-actor", id: 100 },
          created_at: "2026-01-01T00:00:00Z",
        },
        repository: {
          name: "test-repo",
          full_name: "test-org/test-repo",
          owner: { login: "test-org" },
        },
      },
      repo: { owner: "test-org", repo: "test-repo" },
      actor: "test-actor",
    };
    process.env.VIBECTL_CONTEXT_JSON = JSON.stringify(contextJson);
    process.env.TRIGGER_PHRASE = "@vibectl";

    const { parseGitHubContext } = await import(
      `${CCA_ROOT}/src/github/context.ts`
    );
    const { detectMode } = await import(`${CCA_ROOT}/src/modes/detector.ts`);

    const context = parseGitHubContext();
    const mode = detectMode(context);

    assert(mode === "tag", `Expected tag mode, got ${mode}`);
    console.log(`         Detected mode: ${mode}`);
  },
);

// --- 4. Output Scanner Validation ---
console.log("\n[Output Scanner]");

await check("scanForSecrets detects known secret patterns", async () => {
  const { scanForSecrets } = await import(
    `${CCA_ROOT}/src/vibectl/output-scanner.ts`
  );

  const textWithSecret = [
    "Here is some output from Claude.",
    "Found credentials: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    "End of output.",
  ].join("\n");

  const result = scanForSecrets(textWithSecret);

  assert(result.containsSecrets === true, "Should detect secret in output");
  assert(
    result.matchCount >= 1,
    `Expected matches >= 1, got ${result.matchCount}`,
  );
  assert(
    result.findings.some((f) => f.patternName === "github-pat-classic"),
    "Should identify github-pat-classic pattern",
  );

  console.log(`         Detected ${result.matchCount} secret(s)`);
  console.log(
    `         Patterns: ${result.findings.map((f) => f.patternName).join(", ")}`,
  );
});

await check("scanForSecrets returns clean for safe text", async () => {
  const { scanForSecrets } = await import(
    `${CCA_ROOT}/src/vibectl/output-scanner.ts`
  );

  const cleanText = "This is a normal code review with no secrets present.";
  const result = scanForSecrets(cleanText);

  assert(
    result.containsSecrets === false,
    "Should not detect secrets in clean text",
  );
  assert(
    result.matchCount === 0,
    `Expected 0 matches, got ${result.matchCount}`,
  );
});

await check("redactSecrets replaces detected secrets", async () => {
  const { redactSecrets } = await import(
    `${CCA_ROOT}/src/vibectl/output-scanner.ts`
  );

  const textWithSecret =
    "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij found.";
  const { redacted, scanResult } = redactSecrets(textWithSecret);

  assert(scanResult.containsSecrets === true, "Should detect secret");
  assert(redacted.includes("[REDACTED]"), "Should contain [REDACTED] marker");
  assert(
    !redacted.includes("ghp_ABCDEFGH"),
    "Should not contain original secret",
  );

  console.log(`         Redacted output verified`);
});

await check(
  "scanForSecrets detects diverse pattern categories in-container",
  async () => {
    const { scanForSecrets } = await import(
      `${CCA_ROOT}/src/vibectl/output-scanner.ts`
    );

    // Each line contains a test secret from a different pattern category.
    // This validates the scanner mechanism works across diverse pattern types
    // inside the container, not just the github-pat-classic tested above.
    const diverseSecrets = [
      // 1. AWS access key (cloud provider)
      "AWS_KEY=AKIAIOSFODNN7EXAMPLE",
      // 2. Private key header (cryptographic material)
      "-----BEGIN RSA PRIVATE KEY-----",
      // 3. Stripe secret key (payment provider)
      "stripe_key: " + "sk_" + "live_abcdefghijklmnopqrstuvwx",
      // 4. Slack bot token (messaging platform)
      "SLACK_TOKEN=" +
        "xoxb-" +
        "1234567890-1234567890-ABCDEFGHIJKLMNOPQRSTUVWx",
      // 5. JWT token (authentication)
      "token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      // 6. npm token (package registry)
      "NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz1234567890",
    ].join("\n");

    const result = scanForSecrets(diverseSecrets);

    assert(
      result.containsSecrets === true,
      "Should detect secrets across categories",
    );

    // Verify at least 5 distinct pattern categories detected
    const detectedPatterns = new Set(result.findings.map((f) => f.patternName));

    const expectedPatterns = [
      "aws-access-key-id",
      "private-key-rsa",
      "stripe-secret-key",
      "slack-bot-token",
      "jwt-token",
    ];

    const missingPatterns = expectedPatterns.filter(
      (p) => !detectedPatterns.has(p),
    );

    assert(
      missingPatterns.length === 0,
      `Missing pattern detections: ${missingPatterns.join(", ")}. Detected: ${[...detectedPatterns].join(", ")}`,
    );

    console.log(`         Detected ${result.matchCount} secret(s)`);
    console.log(`         Categories: ${[...detectedPatterns].join(", ")}`);
  },
);

// --- 5. Entry Adapter Execution Chain ---
console.log("\n[Entry Adapter - Execution Chain]");

await check(
  "executeTask processes mock payload through auth, context, mode detection, and reaches CCA prepare phase",
  async () => {
    restoreEnv();

    const { executeTask } = await import(
      `${CCA_ROOT}/src/vibectl/entry-adapter.ts`
    );

    // Construct a realistic mock task payload
    const payload = {
      credentials: {
        githubToken: "ghs_integration_test_token_placeholder_x",
        aiProxyUrl: "https://ai-proxy.test.vibectl.dev/v1/proxy/cust_test",
        proxyHeaders: { "X-Proxy-Token": "test-proxy-hmac-value" },
        repoOwner: "test-org",
        repoName: "test-repo",
        eventName: "issue_comment",
        botUserId: "123456",
        botLogin: "vibectl-test[bot]",
      },
      contextJson: {
        eventName: "issue_comment",
        payload: {
          action: "created",
          issue: {
            number: 42,
            title: "Integration test issue",
            body: "Testing the execution chain",
            pull_request: undefined,
            user: { login: "test-actor", id: 100 },
          },
          comment: {
            id: 1,
            body: "@vibectl review this code for integration testing",
            user: { login: "test-actor", id: 100 },
            created_at: "2026-01-01T00:00:00Z",
          },
          repository: {
            name: "test-repo",
            full_name: "test-org/test-repo",
            owner: { login: "test-org" },
          },
        },
        repo: { owner: "test-org", repo: "test-repo" },
        actor: "test-actor",
      },
      taskConfig: {
        trigger_phrase: "@vibectl",
        mode: "tag",
      },
    };

    // Execute the task — expect failure at GitHub API boundary
    const result = await executeTask(payload);

    // The execution should fail because there is no GitHub API access
    // in the container. This is EXPECTED — it proves the chain executed
    // through auth bridge, context parsing, mode detection, and reached
    // CCA's permission check (which requires a live GitHub API).
    assert(
      result.success === false,
      "Expected failure (no GitHub API in container)",
    );
    assert(
      result.error !== undefined,
      "Expected error message from API failure",
    );

    // The error's [stage] prefix proves how far the chain progressed.
    // Entry adapter formats errors as "[stage] detail" (see entry-adapter.ts).
    // A [prepare] prefix means:
    // - Auth bridge ran (stage: auth passed)
    // - Context parsed (stage: context passed)
    // - CCA's prepare phase was reached (permission check invoked)
    //
    // This assertion is resilient to CCA changing error message wording —
    // it validates the execution chain reached the expected stage boundary,
    // not the specific error text from the GitHub API or network layer.
    assert(
      result.error.startsWith("[prepare]"),
      `Error should originate from prepare stage (chain reached CCA internals). Got: ${result.error}`,
    );

    // Verify auth bridge configured the environment during execution
    assert(
      process.env.GITHUB_TOKEN === "ghs_integration_test_token_placeholder_x",
      "Auth bridge should have set GITHUB_TOKEN",
    );
    assert(
      process.env.ANTHROPIC_BASE_URL ===
        "https://ai-proxy.test.vibectl.dev/v1/proxy/cust_test",
      "Auth bridge should have set ANTHROPIC_BASE_URL",
    );
    assert(
      process.env.BOT_USER_ID === "123456",
      "Auth bridge should have set BOT_USER_ID",
    );
    assert(
      process.env.VIBECTL_CONTEXT_JSON !== undefined,
      "Entry adapter should have set VIBECTL_CONTEXT_JSON",
    );

    // Mode detection evidence
    assert(
      result.mode === "tag" || result.mode === "agent",
      "Mode should be set",
    );

    console.log(`         Result: success=${result.success} (expected false)`);
    console.log(`         Mode: ${result.mode}`);
    console.log(`         Error: ${result.error?.substring(0, 120)}...`);
    console.log(
      `         Chain validated: auth -> context -> mode -> CCA prepare`,
    );
  },
);

// --- Summary ---
restoreEnv();

console.log(`\n===============================`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
