# vibectl Fork Changes

This document tracks all modifications made to the vibectl fork of
[anthropics/claude-code-action](https://github.com/anthropics/claude-code-action),
per the fork governance model.

## Branch Structure

| Branch              | Purpose                                  | Update Mechanism                      |
| ------------------- | ---------------------------------------- | ------------------------------------- |
| `upstream-tracking` | Clean mirror of upstream `main`          | Automated sync (daily fetch)          |
| `vibectl-main`      | Production branch with vibectl additions | Upstream sync merge + vibectl changes |

## Fork Governance

### Sync Process

Upstream sync is automated via `.github/workflows/upstream-sync.yml` with two modes:

| Mode        | Trigger                    | Action                                                               |
| ----------- | -------------------------- | -------------------------------------------------------------------- |
| **Track**   | Daily cron (06:00 UTC)     | Fast-forwards `upstream-tracking` to match `upstream/main`. No PR.   |
| **Sync PR** | Manual `workflow_dispatch` | Creates PR from `upstream-tracking` into `vibectl-main` with review. |

**Sync cadence**: Daily silent tracking. On-demand PR creation when sync is needed (routine monthly, immediate for security fixes).

**How to create a sync PR**:

```bash
gh workflow run upstream-sync.yml -f mode=create-pr
```

The sync PR includes:

- Per-directory conflict risk classification (see Merge Conflict Risk Assessment below)
- List of upstream commits pending merge
- Upstream workflow file detection (see Workflow Policy below)
- Review checklist for the human reviewer

**No auto-merge**: All sync PRs require human review. Even conflict-free merges may introduce behavioral changes, new dependencies, or env var assumptions that affect vibectl's security model.

### Diff Visibility

- **Fork diff**: `git diff upstream-tracking...vibectl-main` shows the exact fork diff
- **Pending upstream**: `git log vibectl-main..upstream-tracking --oneline` shows unsynced upstream commits
- **Conflict resolution**: Temporary `sync/upstream-YYYY-MM-DD` branches isolate merge work from `vibectl-main`

### Workflow Policy (Option D)

Upstream CCA workflows (`.github/workflows/`) are **not carried into vibectl-main**. vibectl maintains its own CI workflows independently.

**Rationale**: CCA's workflows are designed for Anthropic's CI infrastructure (GitHub-hosted runners, Anthropic API keys for integration tests, CCA-specific release automation). These do not fit vibectl's model (self-hosted runner, no Anthropic API in fork CI, different release cadence). Carrying upstream workflows would create maintenance burden and false CI failures.

**When upstream adds or modifies workflows**: The sync PR body flags these files with an Option D policy notice. The reviewer decides per-file:

- **Ignore**: upstream workflow not relevant to vibectl
- **Adapt**: create a vibectl-equivalent workflow inspired by upstream intent
- **Adopt**: carry the upstream workflow (exception to Option D — document rationale in this file)

### CI Validation for Sync PRs

The upstream-sync workflow dispatches `ci-all.yml` on the sync branch after creating the PR. This runs the full fork CI suite (unit tests, formatting, type checking) against the merged code before human review. The sync PR also triggers CI automatically via the `pull_request` event on `ci-all.yml`.

## Applied Patches

### Minimally Patched Files (3 files, 64 lines net change)

#### `src/github/constants.ts` — Bot identity configuration

**Justification** (EP150 Section 2.1, Component #24): CCA hardcodes Claude's GitHub App bot ID (41898282) and login (`claude[bot]`). vibectl uses its own GitHub App with a different bot identity. Without this patch, comment filtering, actor detection, and bot identification would reference Claude's bot instead of vibectl's.

**What changed**: `CLAUDE_APP_BOT_ID` and `CLAUDE_BOT_LOGIN` read from `BOT_USER_ID` and `BOT_LOGIN` env vars respectively, falling back to CCA's original hardcoded values when env vars are absent.

**Lines changed**: +10/-4 (6 net)

**Re-application after upstream sync**:

```typescript
// Replace hardcoded values with:
export const CLAUDE_APP_BOT_ID = Number(process.env.BOT_USER_ID ?? "41898282");
export const CLAUDE_BOT_LOGIN = process.env.BOT_LOGIN ?? "claude[bot]";
```

**Tests**: `test/vibectl/constants-fallback.test.ts` — verifies CCA defaults when env vars absent, and custom values when set.

---

#### `src/github/context.ts` — Context construction fallback

**Justification** (EP150 Section 2.1, Component #11; Section 6): CCA's `parseGitHubContext()` calls `github.context` from `@actions/github`, which reads `GITHUB_EVENT_PATH` and `GITHUB_REPOSITORY` env vars set by the GitHub Actions runner. In vibectl's container, these env vars do not exist and `@actions/github` context construction fails. Without this patch, CCA cannot determine the event type, repository, or actor.

**What changed**: Added `getRawContext()` helper that checks for `VIBECTL_CONTEXT_JSON` env var first. If set, parses the JSON to construct the context object (same shape as `@actions/github` context: `eventName`, `payload`, `repo`, `actor`). If not set, falls through to `github.context` (original behavior). Also changed `GITHUB_RUN_ID` from non-null assertion (`!`) to fallback (`|| "0"`) for safety in non-Actions contexts. JSON.parse is wrapped in try-catch for meaningful error messages on malformed input. Required properties (`eventName`, `payload`, `repo`, `actor`) are validated after parse with descriptive errors.

**Lines changed**: +47/-2 (45 net)

**`VIBECTL_CONTEXT_JSON` schema**:

```json
{
  "eventName": "issue_comment",
  "payload": {
    /* webhook event payload */
  },
  "repo": { "owner": "org-name", "repo": "repo-name" },
  "actor": "username"
}
```

**Re-application after upstream sync**: Add `getRawContext()` function before `parseGitHubContext()` and replace `github.context` reference with `getRawContext()` call. Change `process.env.GITHUB_RUN_ID!` to `process.env.GITHUB_RUN_ID || "0"`. Include try-catch around `JSON.parse` and required property validation for `eventName`, `payload`, `repo` (with `owner` and `repo` sub-properties), and `actor`.

**Tests**: `test/vibectl/context-fallback.test.ts` — verifies issue_comment and pull_request context construction from JSON, fallback runId, input env var reading, malformed JSON error handling, and missing property validation (eventName, payload, repo, repo.owner, actor).

---

#### `src/entrypoints/collect-inputs.ts` — Task config file fallback

**Justification** (EP150 Section 2.1, Component #6): CCA reads `ALL_INPUTS` env var (set by `${{ toJson(inputs) }}` in the GitHub Actions workflow). In vibectl's container, GitHub Actions input resolution is unavailable. Without this patch, all action inputs would appear unset, causing CCA to use only defaults.

**What changed**: Added a fallback path that reads from a JSON file specified by `VIBECTL_TASK_CONFIG` env var when `ALL_INPUTS` is absent. Also added a top-level `import { readFileSync } from "fs"` (consistent with CCA's import style).

**Lines changed**: +14/-1 (13 net)

**Re-application after upstream sync**: After `const allInputsJson = process.env.ALL_INPUTS;`, add fallback block that checks `VIBECTL_TASK_CONFIG` env var and reads the file with `readFileSync`. Change `const` to `let`.

**Tests**: `test/vibectl/collect-inputs-fallback.test.ts` — verifies default behavior, ALL_INPUTS precedence, file fallback, and graceful handling of missing files.

### Zero-Change Files (env var approach)

#### `src/github/operations/git-config.ts` — No code change needed

**Justification** (EP150 Section 2.1, Component #19): Uses `GITHUB_SERVER_URL` from `src/github/api/config.ts`, which already has a default value (`"https://github.com"`). The vibectl entry adapter sets `GITHUB_SERVER_URL` as an env var if a non-default value is needed. No code modification required.

#### `src/mcp/install-mcp-server.ts` — No code change needed

**Justification** (EP150 Section 8.4, Option 1): References `process.env.GITHUB_ACTION_PATH` for MCP server script paths. The vibectl entry adapter sets `GITHUB_ACTION_PATH=/opt/cca` (where CCA source is installed in the container Dockerfile). This is a zero-diff approach that preserves the file unchanged.

## vibectl Integration Layer (3 files, 561 LOC total)

These files compose on top of Phase 2's CCA source patches to form a complete execution path from task payload to scanned output. They live in `src/vibectl/` and have zero merge conflict risk with upstream CCA.

### `src/vibectl/entry-adapter.ts` — CCA execution orchestrator (207 LOC)

**Justification** (EP150 Section 4.2, Option B — recompose from CCA internals): CCA's `run.ts` is tightly coupled to GitHub Actions lifecycle (`@actions/core`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`). The entry adapter recomposes the same orchestration from CCA's internal imports (`detectMode`, `prepareTagMode`, `prepareAgentMode`, `runClaude`) with vibectl's lifecycle. This keeps `run.ts` and `token.ts` untouched as dead code (zero diff, zero merge conflict risk).

**What it does**: Parses a vibectl task payload, configures auth (via auth-bridge), sets `VIBECTL_CONTEXT_JSON` (activating the Phase 2 context.ts patch), detects mode, invokes CCA's prepare and run flow, and applies output scanning post-execution.

**Re-application after upstream sync**: Self-contained file in `src/vibectl/`; no conflict risk. If upstream changes CCA internal function signatures, update imports accordingly.

**Tests**: `test/vibectl/mocked/entry-adapter.test.ts` — 15 unit tests verifying orchestration logic with mocked CCA internals; `test/vibectl/mocked/integration.test.ts` — 3 integration tests verifying the full adapter-to-scanner flow.

---

### `src/vibectl/auth-bridge.ts` — Container credential configuration (110 LOC)

**Justification** (EP150 Section 9): CCA's OIDC-based token setup (`token.ts`) is bypassed entirely. The auth bridge configures container environment variables for vibectl's authentication model: GitHub installation token (`GITHUB_TOKEN`), AI proxy URL (`ANTHROPIC_BASE_URL` with proxy headers), bot identity (`BOT_USER_ID`, `BOT_LOGIN`), MCP server paths (`GITHUB_ACTION_PATH`), and `@actions/core` file-based output paths (`GITHUB_OUTPUT`, `GITHUB_ENV`).

**What it does**: Sets `process.env` variables that CCA's internal functions read, creates temp files for `@actions/core` output capture, and returns the temp directory path.

**Re-application after upstream sync**: Self-contained file in `src/vibectl/`; no conflict risk.

**Tests**: `test/vibectl/auth-bridge.test.ts` — 17 unit tests verifying all env var configurations, temp file creation, and default handling.

---

### `src/vibectl/output-scanner.ts` — Post-execution secret detection (244 LOC)

**Justification** (EP150 Section 4.4; OD-4: post-execution only for launch): Applies gitleaks-derived pattern matching to CCA execution output before results are finalized. Contains 29 high-impact patterns covering API keys (Anthropic, OpenAI, AWS, GitHub, Stripe, Slack, npm, SendGrid, Twilio), private keys (RSA, OpenSSH, EC, generic), bearer tokens, JWTs, database connection strings with credentials, GCP service account keys, and generic secret/password assignments.

**What it does**: `scanForSecrets()` detects secrets and returns findings with pattern names and line numbers. `redactSecrets()` replaces matches with `[REDACTED]`. Architecture supports pattern expansion — full 224-pattern integration from `@vibectl/shared/sanitize` deferred to EP152.

**Re-application after upstream sync**: Self-contained file in `src/vibectl/`; no conflict risk.

**Tests**: `test/vibectl/output-scanner.test.ts` — 26 unit tests covering all 29 pattern categories, multi-line detection, redaction, empty input handling, and custom pattern support.

## Dead Code in Fork Execution Path

| File Path                | Status    | Rationale                                                                                              |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| `src/entrypoints/run.ts` | Dead code | Entry adapter calls CCA internals directly; `run.ts` is never invoked. Zero diff, zero conflict.       |
| `src/github/token.ts`    | Dead code | Auth bridge injects `GITHUB_TOKEN` directly; OIDC exchange is never invoked. Zero diff, zero conflict. |

## CI/Configuration Changes

| File Path                             | What Changes                                                                                        | Re-application                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `.github/workflows/ci.yml`            | Fork CI: pinned Bun 1.2.12 across all jobs, dependency caching via `actions/cache`                  | Maintained independently from upstream CI |
| `.github/workflows/ci-all.yml`        | Orchestrates CI with `workflow_dispatch`; image cleanup logs errors instead of swallowing           | Maintained independently from upstream CI |
| `.github/workflows/upstream-sync.yml` | Daily tracking + on-demand sync PR with risk classification and patched file inventory              | Fork-only file; no conflict risk          |
| `ci/Dockerfile.smoke-test`            | CI container image: base image SHA-pinned, Bun installed via checksum-verified zip (not curl\|bash) | Fork-only file; no conflict risk          |
| `ci/smoke-test.ts`                    | Smoke test: CCA imports, container layout, TypeScript transpilation (19 checks)                     | Fork-only file; no conflict risk          |
| `ci/integration-test.ts`              | Integration test: CCA execution chain, diverse scanner patterns (8 checks)                          | Fork-only file; no conflict risk          |
| `FORK_CHANGES.md`                     | This document                                                                                       | Fork-only file; no conflict risk          |

### CI Hardening Details

- **Bun version determinism**: All CI jobs (test, prettier, typecheck) use `oven-sh/setup-bun@v2` with `bun-version: 1.2.12`. No `latest` tags.
- **Dependency caching**: `actions/cache@v4` caches `~/.bun/install/cache` keyed on `bun.lock` hash, reducing redundant installs.
- **Dockerfile supply chain**: Bun installed via direct zip download + `sha256sum -c` verification against published checksums, replacing `curl | bash`.
- **Dockerfile reproducibility**: Base image (`debian:trixie-slim`) pinned to SHA256 digest.
- **Error visibility**: Container image cleanup step logs errors to stdout instead of redirecting to `/dev/null`.
- **Sync PR transparency**: Upstream sync PR body includes patched file inventory listing all CCA source files modified by vibectl.
- **Integration test resilience**: Error detection uses structured `[stage]` prefix assertion instead of fragile OR-chained error message string matching. Resilient to CCA changing error message wording.
- **Scanner pattern coverage**: Integration test validates 6 diverse pattern categories in-container (AWS, RSA private key, Stripe, Slack, JWT, npm), not just github-pat-classic.
- **TypeScript transpilation**: Smoke test verifies Bun can transpile 4 CCA entry points (entry-adapter, collect-inputs, context, detector), catching import graph errors beyond individual module resolution.

## Test Organization

Tests that use `mock.module()` for CCA internal functions are isolated in `test/vibectl/mocked/` to prevent Bun's global module mock cache from affecting other test files in the same run. This is a Bun test runner constraint — `mock.module()` is process-global.

| Test Directory                       | Test Count | Description                                     |
| ------------------------------------ | ---------- | ----------------------------------------------- |
| `test/vibectl/`                      | 81         | Unit tests (no mock.module, no cache pollution) |
| `test/vibectl/mocked/`               | 22         | Entry adapter + integration (mock.module used)  |
| CCA suite (test/, base-action/test/) | 634        | Original CCA tests (zero regressions)           |
| **Total**                            | **737**    | All passing                                     |

## Diff Surface Summary

| Metric                             | Value                         |
| ---------------------------------- | ----------------------------- |
| Total CCA source LOC               | ~8,700                        |
| Lines untouched                    | ~7,527 (86.5%)                |
| Lines changed in applied patches   | 64 net (3 files)              |
| New vibectl-specific lines         | 573 (3 files in src/vibectl/) |
| Dead code (untouched, bypassed)    | 466 (run.ts + token.ts)       |
| **CCA source diff (patches only)** | **64 lines (0.7%)**           |

## Merge Conflict Risk Assessment

| CCA Directory            | Conflict Risk | Rationale                                                                   |
| ------------------------ | ------------- | --------------------------------------------------------------------------- |
| `ci/`                    | NONE          | vibectl-only directory; CI smoke test Dockerfile and script                 |
| `src/vibectl/`           | NONE          | vibectl-only directory; does not exist in upstream                          |
| `src/mcp/`               | NONE          | Zero-diff approach: `GITHUB_ACTION_PATH` set by entry adapter env var       |
| `src/entrypoints/`       | LOW           | `run.ts` untouched (dead code); `collect-inputs.ts` small patch (+13 lines) |
| `src/github/`            | HIGH          | `context.ts` has high upstream churn and receives a +45 line patch          |
| `src/github/operations/` | NONE          | Zero-diff approach: `GITHUB_SERVER_URL` already has default in `config.ts`  |
| `src/modes/`             | NONE          | No vibectl modifications                                                    |
| `src/create-prompt/`     | NONE          | No vibectl modifications                                                    |
| `base-action/src/`       | NONE          | No vibectl modifications                                                    |
