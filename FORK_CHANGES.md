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

- List of upstream commits pending merge
- Changed files list
- Conflict warning if merge conflicts are present

**No auto-merge**: All sync PRs require human review. Even conflict-free merges may introduce behavioral changes, new dependencies, or env var assumptions that affect vibectl's security model.

### Diff Visibility

- **Fork diff**: `git diff upstream-tracking...vibectl-main` shows the exact fork diff
- **Pending upstream**: `git log vibectl-main..upstream-tracking --oneline` shows unsynced upstream commits
- **Conflict resolution**: Temporary `sync/upstream-YYYY-MM-DD` branches isolate merge work from `vibectl-main`

### Workflow Policy

Upstream CCA workflows (`.github/workflows/`) are **not carried into vibectl-main**. vibectl maintains its own CI workflows independently.

**Rationale**: CCA's workflows are designed for Anthropic's CI infrastructure (GitHub-hosted runners, Anthropic API keys for integration tests, CCA-specific release automation). These do not fit vibectl's model (self-hosted runner, no Anthropic API in fork CI, different release cadence).

**When upstream adds or modifies workflows**: Review the diff in the sync PR and decide per-file: Ignore, Adapt (create vibectl equivalent), or Adopt (document rationale).

## Applied Patches

### Minimally Patched Files (3 files, 96 lines net change)

#### `src/github/constants.ts` — Bot identity configuration

**Justification** (EP150 Section 2.1, Component #24): CCA hardcodes Claude's GitHub App bot ID (41898282) and login (`claude[bot]`). vibectl uses its own GitHub App with a different bot identity. Without this patch, comment filtering, actor detection, and bot identification would reference Claude's bot instead of vibectl's.

**What changed**: `CLAUDE_APP_BOT_ID` and `CLAUDE_BOT_LOGIN` read from `BOT_USER_ID` and `BOT_LOGIN` env vars respectively, falling back to CCA's original hardcoded values when env vars are absent. `CLAUDE_APP_BOT_ID` includes a NaN guard: if `BOT_USER_ID` is set but non-numeric (e.g., typo, empty after misconfiguration), it falls back to CCA's default rather than silently producing NaN, which would break comment filtering and actor detection.

**Lines changed**: +16/-4 (12 net)

**Re-application after upstream sync**:

```typescript
// Replace hardcoded values with:
const parsedBotId = Number(process.env.BOT_USER_ID ?? "41898282");
export const CLAUDE_APP_BOT_ID = Number.isNaN(parsedBotId)
  ? 41898282
  : parsedBotId;
export const CLAUDE_BOT_LOGIN = process.env.BOT_LOGIN ?? "claude[bot]";
```

**Tests**: `test/vibectl/constants-fallback.test.ts` — verifies CCA defaults when env vars absent, custom values when set, and NaN guard when BOT_USER_ID is non-numeric.

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

**What changed**: Added a fallback path that reads from a JSON file specified by `VIBECTL_TASK_CONFIG` env var when `ALL_INPUTS` is absent. Also added a top-level `import { readFileSync } from "fs"` (consistent with CCA's import style). The catch block distinguishes expected failures (ENOENT — file not found) from unexpected errors (EACCES, EIO, etc.) and logs a warning for unexpected errors so operators can diagnose without failing the task.

**Lines changed**: +27/-1 (26 net)

**Re-application after upstream sync**: After `const allInputsJson = process.env.ALL_INPUTS;`, add fallback block that checks `VIBECTL_TASK_CONFIG` env var and reads the file with `readFileSync`. Change `const` to `let`. The catch block should distinguish ENOENT (expected, silent) from unexpected errors (log warning with `console.warn`).

**Tests**: `test/vibectl/collect-inputs-fallback.test.ts` — verifies default behavior, ALL_INPUTS precedence, file fallback, and graceful handling of missing files.

### Zero-Change Files (env var approach)

#### `src/github/operations/git-config.ts` — No code change needed

**Justification** (EP150 Section 2.1, Component #19): Uses `GITHUB_SERVER_URL` from `src/github/api/config.ts`, which already has a default value (`"https://github.com"`). The vibectl entry adapter sets `GITHUB_SERVER_URL` as an env var if a non-default value is needed. No code modification required.

#### `src/mcp/install-mcp-server.ts` — No code change needed

**Justification** (EP150 Section 8.4, Option 1): References `process.env.GITHUB_ACTION_PATH` for MCP server script paths. The vibectl entry adapter sets `GITHUB_ACTION_PATH=/opt/cca` (where CCA source is installed in the container Dockerfile). This is a zero-diff approach that preserves the file unchanged.

## vibectl Integration Layer (2 files, 359 LOC total)

These files bridge vibectl's container dispatch to CCA's GitHub Actions execution model. They live in `src/vibectl/` and have zero merge conflict risk with upstream CCA.

### `src/vibectl/entry-adapter.ts` — CCA execution orchestrator (238 LOC)

**Justification** (EP150 Section 4.2, Option B — recompose from CCA internals): CCA's `run.ts` is tightly coupled to GitHub Actions lifecycle (`@actions/core`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`). The entry adapter recomposes the same orchestration from CCA's internal imports (`detectMode`, `prepareTagMode`, `prepareAgentMode`, `runClaude`) with vibectl's lifecycle. This keeps `run.ts` and `token.ts` untouched as dead code (zero diff, zero merge conflict risk).

**What it does**: Parses a vibectl task payload, configures auth (via auth-bridge), sets `VIBECTL_CONTEXT_JSON` (activating the Phase 2 context.ts patch), detects mode, and invokes CCA's prepare and run flow. Includes documented architecture decisions: permission override rationale (installation token always provides override capability), plugin installation omission (container model handles plugins at platform level), and runClaude parameter omissions (SDK-direct execution, programmatic output capture).

**Re-application after upstream sync**: Self-contained file in `src/vibectl/`; no conflict risk. If upstream changes CCA internal function signatures, update imports accordingly.

**Tests**: `test/vibectl/mocked/entry-adapter.test.ts` — unit tests verifying orchestration logic with mocked CCA internals; `test/vibectl/mocked/integration.test.ts` — integration test verifying the full adapter flow.

---

### `src/vibectl/auth-bridge.ts` — Container credential configuration (121 LOC)

**Justification** (EP150 Section 9): CCA's OIDC-based token setup (`token.ts`) is bypassed entirely. The auth bridge configures container environment variables for vibectl's authentication model: GitHub installation token (`GITHUB_TOKEN`), AI proxy URL (`ANTHROPIC_BASE_URL` with proxy headers), bot identity (`BOT_USER_ID`, `BOT_LOGIN`), MCP server paths (`GITHUB_ACTION_PATH`), and `@actions/core` file-based output paths (`GITHUB_OUTPUT`, `GITHUB_ENV`).

**What it does**: Sets `process.env` variables that CCA's internal functions read, creates temp files for `@actions/core` output capture, and returns the temp directory path.

**Re-application after upstream sync**: Self-contained file in `src/vibectl/`; no conflict risk.

**Tests**: `test/vibectl/auth-bridge.test.ts` — unit tests verifying all env var configurations, temp file creation, and default handling.

## Dead Code in Fork Execution Path

| File Path                | Status    | Rationale                                                                                              |
| ------------------------ | --------- | ------------------------------------------------------------------------------------------------------ |
| `src/entrypoints/run.ts` | Dead code | Entry adapter calls CCA internals directly; `run.ts` is never invoked. Zero diff, zero conflict.       |
| `src/github/token.ts`    | Dead code | Auth bridge injects `GITHUB_TOKEN` directly; OIDC exchange is never invoked. Zero diff, zero conflict. |

## CI/Configuration Changes

| File Path                             | What Changes                                                                                        | Re-application                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `.github/workflows/ci.yml`            | Fork CI: unit tests, formatting, type checking. Pinned Bun 1.2.12, dependency caching.             | Maintained independently from upstream CI |
| `.github/workflows/upstream-sync.yml` | Daily tracking + on-demand sync PR creation                                                         | Fork-only file; no conflict risk          |
| `FORK_CHANGES.md`                     | This document                                                                                       | Fork-only file; no conflict risk          |

## Test Organization

Tests that use `mock.module()` for CCA internal functions are isolated in `test/vibectl/mocked/` to prevent Bun's global module mock cache from affecting other test files in the same run. This is a Bun test runner constraint — `mock.module()` is process-global.

## Diff Surface Summary

| Metric                             | Value                         |
| ---------------------------------- | ----------------------------- |
| Total CCA source LOC               | ~8,700                        |
| Lines changed in applied patches   | 96 net (3 files)              |
| New vibectl-specific lines         | 359 (2 files in src/vibectl/) |
| Dead code (untouched, bypassed)    | 466 (run.ts + token.ts)       |
| **CCA source diff (patches only)** | **96 lines (1.1%)**           |

## Merge Conflict Risk Assessment

| CCA Directory            | Conflict Risk | Rationale                                                                   |
| ------------------------ | ------------- | --------------------------------------------------------------------------- |
| `src/vibectl/`           | NONE          | vibectl-only directory; does not exist in upstream                          |
| `src/mcp/`               | NONE          | Zero-diff approach: `GITHUB_ACTION_PATH` set by entry adapter env var       |
| `src/entrypoints/`       | LOW           | `run.ts` untouched (dead code); `collect-inputs.ts` small patch (+13 lines) |
| `src/github/`            | HIGH          | `context.ts` has high upstream churn and receives a +45 line patch          |
| `src/github/operations/` | NONE          | Zero-diff approach: `GITHUB_SERVER_URL` already has default in `config.ts`  |
| `src/modes/`             | NONE          | No vibectl modifications                                                    |
| `src/create-prompt/`     | NONE          | No vibectl modifications                                                    |
| `base-action/src/`       | NONE          | No vibectl modifications                                                    |
