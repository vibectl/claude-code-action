#!/usr/bin/env bun

import { describe, test, expect } from "bun:test";
import {
  scanForSecrets,
  redactSecrets,
  HIGH_IMPACT_PATTERNS,
} from "../../src/vibectl/output-scanner.ts";

describe("output-scanner", () => {
  describe("scanForSecrets", () => {
    test("returns clean result for text without secrets", () => {
      const result = scanForSecrets(
        "This is a normal code review response.\nNo secrets here.",
      );
      expect(result.containsSecrets).toBe(false);
      expect(result.matchCount).toBe(0);
      expect(result.findings).toEqual([]);
    });

    test("detects Anthropic API key", () => {
      const fakeKey =
        "sk-ant-api03-" + "A".repeat(86) + "-" + "B".repeat(4) + "BBAA";
      const text = `Here is the key: ${fakeKey}`;
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "anthropic-api-key"),
      ).toBe(true);
    });

    test("detects GitHub PAT (classic)", () => {
      const text = "Use this token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "github-pat-classic"),
      ).toBe(true);
    });

    test("detects GitHub App token (ghs_)", () => {
      const text = "token=ghs_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "github-app-token"),
      ).toBe(true);
    });

    test("detects RSA private key header", () => {
      const text = [
        "Here is a key:",
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEpAIBAAKCAQEA...",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "private-key-rsa"),
      ).toBe(true);
      expect(result.findings[0]!.line).toBe(2);
    });

    test("detects OpenSSH private key header", () => {
      const text = "-----BEGIN OPENSSH PRIVATE KEY-----";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "private-key-openssh"),
      ).toBe(true);
    });

    test("detects generic private key header", () => {
      const text = "-----BEGIN PRIVATE KEY-----";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "private-key-generic"),
      ).toBe(true);
    });

    test("detects AWS access key ID", () => {
      const text = "aws_access_key_id = AKIAIOSFODNN7EXAMPLE";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "aws-access-key-id"),
      ).toBe(true);
    });

    test("detects Bearer token", () => {
      const text =
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      // Should match either bearer-token or jwt-token pattern (or both)
      expect(result.matchCount).toBeGreaterThanOrEqual(1);
    });

    test("detects Stripe secret key", () => {
      // Constructed via concatenation to avoid triggering GitHub push protection
      const prefix = "sk" + "_live_";
      const text = `stripe.apiKey = ${prefix}ABCDEFGHIJKLMNOPQRSTUVWXyz`;
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "stripe-secret-key"),
      ).toBe(true);
    });

    test("detects Slack bot token", () => {
      // Constructed via concatenation to avoid triggering GitHub push protection
      const prefix = "xoxb" + "-1234567890-1234567890-";
      const text = `SLACK_TOKEN=${prefix}ABCDEFGHIJKLMNOPQRSTUVWX`;
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "slack-bot-token"),
      ).toBe(true);
    });

    test("detects npm token", () => {
      const text =
        "//registry.npmjs.org/:_authToken=npm_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(result.findings.some((f) => f.patternName === "npm-token")).toBe(
        true,
      );
    });

    test("detects SendGrid API key", () => {
      const text =
        "SENDGRID_API_KEY=SG.ABCDEFGHIJKLMNOPQRSTUv.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some((f) => f.patternName === "sendgrid-api-key"),
      ).toBe(true);
    });

    test("detects database connection string with password", () => {
      const text =
        "DATABASE_URL=postgres://admin:supersecretpassword@db.example.com:5432/mydb";
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some(
          (f) => f.patternName === "connection-string-password",
        ),
      ).toBe(true);
    });

    test("detects GCP service account key marker", () => {
      const text = '{"type": "service_account", "project_id": "my-project"}';
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some(
          (f) => f.patternName === "gcp-service-account-key",
        ),
      ).toBe(true);
    });

    test("detects generic password assignment", () => {
      const text = 'password = "my-secret-password-123"';
      const result = scanForSecrets(text);
      expect(result.containsSecrets).toBe(true);
      expect(
        result.findings.some(
          (f) => f.patternName === "generic-password-assignment",
        ),
      ).toBe(true);
    });

    test("reports correct line numbers for multi-line text", () => {
      const text = [
        "Line 1: clean",
        "Line 2: clean",
        "Line 3: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "Line 4: clean",
        "Line 5: -----BEGIN RSA PRIVATE KEY-----",
      ].join("\n");
      const result = scanForSecrets(text);
      expect(result.matchCount).toBe(2);

      const patFinding = result.findings.find(
        (f) => f.patternName === "github-pat-classic",
      );
      expect(patFinding?.line).toBe(3);

      const keyFinding = result.findings.find(
        (f) => f.patternName === "private-key-rsa",
      );
      expect(keyFinding?.line).toBe(5);
    });

    test("handles empty string", () => {
      const result = scanForSecrets("");
      expect(result.containsSecrets).toBe(false);
      expect(result.matchCount).toBe(0);
    });

    test("supports custom patterns", () => {
      const customPatterns = [
        { name: "custom-secret", pattern: /CUSTOM_SECRET_[A-Z]{10}/g },
      ];
      const text = "key=CUSTOM_SECRET_ABCDEFGHIJ";
      const result = scanForSecrets(text, customPatterns);
      expect(result.containsSecrets).toBe(true);
      expect(result.findings[0]!.patternName).toBe("custom-secret");
    });
  });

  describe("redactSecrets", () => {
    test("returns unmodified text when no secrets found", () => {
      const text = "This is clean text";
      const { redacted, scanResult } = redactSecrets(text);
      expect(redacted).toBe(text);
      expect(scanResult.containsSecrets).toBe(false);
    });

    test("replaces GitHub PAT with [REDACTED]", () => {
      const text = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
      const { redacted, scanResult } = redactSecrets(text);
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain("ghp_");
      expect(scanResult.containsSecrets).toBe(true);
    });

    test("replaces private key header with [REDACTED]", () => {
      const text =
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----";
      const { redacted } = redactSecrets(text);
      expect(redacted).toContain("[REDACTED]");
      expect(redacted).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
    });

    test("replaces multiple secrets in same text", () => {
      const text = [
        "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
        "-----BEGIN PRIVATE KEY-----",
      ].join("\n");
      const { redacted, scanResult } = redactSecrets(text);
      expect(scanResult.matchCount).toBeGreaterThanOrEqual(2);
      expect(redacted).not.toContain("ghp_");
      expect(redacted).not.toContain("-----BEGIN PRIVATE KEY-----");
    });
  });

  describe("generic pattern false-positive mitigation", () => {
    test("generic-api-key-assignment does not match unquoted values", () => {
      const text = "api_key = some-value-without-quotes";
      const result = scanForSecrets(text);
      const finding = result.findings.find(
        (f) => f.patternName === "generic-api-key-assignment",
      );
      expect(finding).toBeUndefined();
    });

    test("generic-api-key-assignment does not match short quoted values", () => {
      const text = 'api_key = "short"';
      const result = scanForSecrets(text);
      const finding = result.findings.find(
        (f) => f.patternName === "generic-api-key-assignment",
      );
      expect(finding).toBeUndefined();
    });

    test("generic-secret-assignment does not match values under 16 chars", () => {
      const text = 'secret = "tooshort"';
      const result = scanForSecrets(text);
      const finding = result.findings.find(
        (f) => f.patternName === "generic-secret-assignment",
      );
      expect(finding).toBeUndefined();
    });

    test("generic-password-assignment does not match values under 8 chars", () => {
      const text = 'password = "test"';
      const result = scanForSecrets(text);
      const finding = result.findings.find(
        (f) => f.patternName === "generic-password-assignment",
      );
      expect(finding).toBeUndefined();
    });

    test("callers can exclude generic patterns by passing a filtered list", () => {
      const text = 'api_key = "ABCDEFGHIJKLMNOPQRSTU_long_value"';
      const nonGenericPatterns = HIGH_IMPACT_PATTERNS.filter(
        (p) => !p.name.startsWith("generic-"),
      );
      const result = scanForSecrets(text, nonGenericPatterns);
      expect(result.containsSecrets).toBe(false);
    });
  });

  describe("HIGH_IMPACT_PATTERNS", () => {
    test("contains expected pattern count", () => {
      // Verify we have a reasonable number of high-impact patterns
      expect(HIGH_IMPACT_PATTERNS.length).toBeGreaterThanOrEqual(25);
      expect(HIGH_IMPACT_PATTERNS.length).toBeLessThanOrEqual(40);
    });

    test("all patterns have name and regex", () => {
      for (const pattern of HIGH_IMPACT_PATTERNS) {
        expect(pattern.name).toBeTruthy();
        expect(pattern.pattern).toBeInstanceOf(RegExp);
      }
    });

    test("all patterns use global flag", () => {
      for (const pattern of HIGH_IMPACT_PATTERNS) {
        expect(pattern.pattern.flags).toContain("g");
      }
    });
  });
});
