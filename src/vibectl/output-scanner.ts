/**
 * Output Scanner — Post-execution secret detection for CCA output.
 *
 * Applies gitleaks-based pattern matching to detect secrets in
 * CCA execution output before results are finalized.
 *
 * Architecture: Focused high-impact pattern set (~30 patterns) for launch.
 * Full 224-pattern integration from @vibectl/shared/sanitize deferred to EP152.
 *
 * Per OD-4: Post-execution scanning only. MCP server real-time scanning
 * is not in scope for this phase.
 */

export interface ScanResult {
  /** Whether secrets were detected */
  containsSecrets: boolean;
  /** Number of distinct secret matches */
  matchCount: number;
  /** Types of secrets found */
  findings: SecretFinding[];
}

export interface SecretFinding {
  /** Pattern name that matched */
  patternName: string;
  /** Line number where secret was found (1-indexed) */
  line: number;
}

export interface SecretPattern {
  /** Pattern identifier */
  name: string;
  /** Regex to detect the secret */
  pattern: RegExp;
}

/**
 * High-impact secret patterns for launch.
 *
 * Covers the most common credential types that could appear
 * in AI agent output. Patterns derived from gitleaks rule IDs.
 */
export const HIGH_IMPACT_PATTERNS: readonly SecretPattern[] = [
  // API Keys
  {
    name: "anthropic-api-key",
    pattern: /sk-ant-api\d{2}-[A-Za-z0-9_-]{86}-[A-Za-z0-9_-]{6}AA/g,
  },
  {
    name: "openai-api-key",
    pattern: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g,
  },
  {
    name: "aws-access-key-id",
    pattern:
      /(?:^|[^A-Za-z0-9])((?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16})(?:$|[^A-Za-z0-9])/g,
  },
  {
    name: "aws-secret-access-key",
    pattern:
      /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
  },

  // GitHub tokens
  {
    name: "github-pat-fine-grained",
    pattern: /github_pat_[A-Za-z0-9_]{82}/g,
  },
  {
    name: "github-pat-classic",
    pattern: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    name: "github-oauth-token",
    pattern: /gho_[A-Za-z0-9]{36}/g,
  },
  {
    name: "github-app-token",
    pattern: /(?:ghu|ghs)_[A-Za-z0-9]{36}/g,
  },
  {
    name: "github-refresh-token",
    pattern: /ghr_[A-Za-z0-9]{36}/g,
  },

  // Private keys
  {
    name: "private-key-rsa",
    pattern: /-----BEGIN RSA PRIVATE KEY-----/g,
  },
  {
    name: "private-key-openssh",
    pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/g,
  },
  {
    name: "private-key-ec",
    pattern: /-----BEGIN EC PRIVATE KEY-----/g,
  },
  {
    name: "private-key-generic",
    pattern: /-----BEGIN PRIVATE KEY-----/g,
  },

  // Cloud provider tokens
  {
    name: "gcp-service-account-key",
    pattern: /"type"\s*:\s*"service_account"/g,
  },
  {
    name: "azure-client-secret",
    pattern:
      /(?:client_secret|AZURE_CLIENT_SECRET)\s*[=:]\s*["']?[A-Za-z0-9~._-]{34,}["']?/g,
  },

  // Generic high-value patterns
  {
    name: "bearer-token",
    pattern:
      /(?:Authorization|authorization)\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/=-]{20,}["']?/g,
  },
  {
    name: "generic-api-key-assignment",
    pattern:
      /(?:api[_-]?key|apikey|api[_-]?secret)\s*[=:]\s*["']([A-Za-z0-9_-]{20,})["']/gi,
  },
  {
    name: "generic-password-assignment",
    pattern: /(?:password|passwd|pwd)\s*[=:]\s*["']([^\s"']{8,})["']/gi,
  },
  {
    name: "generic-secret-assignment",
    pattern:
      /(?:secret|SECRET|Secret)\s*[=:]\s*["']([A-Za-z0-9_/+=.-]{16,})["']/g,
  },

  // Slack
  {
    name: "slack-bot-token",
    pattern: /xoxb-[0-9]{10,}-[0-9]{10,}-[A-Za-z0-9]{24}/g,
  },
  {
    name: "slack-webhook-url",
    pattern:
      /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{24}/g,
  },

  // Stripe
  {
    name: "stripe-secret-key",
    pattern: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}/g,
  },

  // npm
  {
    name: "npm-token",
    pattern: /npm_[A-Za-z0-9]{36}/g,
  },

  // Sendgrid
  {
    name: "sendgrid-api-key",
    pattern: /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g,
  },

  // Twilio
  {
    name: "twilio-api-key",
    pattern: /SK[0-9a-fA-F]{32}/g,
  },

  // Database connection strings with credentials
  {
    name: "connection-string-password",
    pattern: /(?:postgres|mysql|mongodb(?:\+srv)?):\/\/[^:]+:([^@\s]{8,})@/g,
  },

  // JWT (long base64-encoded tokens that look like JWTs)
  {
    name: "jwt-token",
    pattern:
      /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
] as const;

/**
 * Scan text for secrets using high-impact patterns.
 *
 * Returns detection results without modifying the input.
 * The caller decides what action to take (block, redact, flag).
 */
export function scanForSecrets(
  text: string,
  patterns: readonly SecretPattern[] = HIGH_IMPACT_PATTERNS,
): ScanResult {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");

  for (const secretPattern of patterns) {
    // Reset regex state for global patterns
    secretPattern.pattern.lastIndex = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Reset for each line
      secretPattern.pattern.lastIndex = 0;
      if (secretPattern.pattern.test(line)) {
        findings.push({
          patternName: secretPattern.name,
          line: i + 1,
        });
      }
    }
  }

  return {
    containsSecrets: findings.length > 0,
    matchCount: findings.length,
    findings,
  };
}

/**
 * Redact secrets from text, replacing matches with [REDACTED].
 *
 * Returns the redacted text and scan results.
 */
export function redactSecrets(
  text: string,
  patterns: readonly SecretPattern[] = HIGH_IMPACT_PATTERNS,
): { redacted: string; scanResult: ScanResult } {
  const scanResult = scanForSecrets(text, patterns);

  if (!scanResult.containsSecrets) {
    return { redacted: text, scanResult };
  }

  let redacted = text;
  for (const secretPattern of patterns) {
    secretPattern.pattern.lastIndex = 0;
    redacted = redacted.replace(secretPattern.pattern, "[REDACTED]");
  }

  return { redacted, scanResult };
}
