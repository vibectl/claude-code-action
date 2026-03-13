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

- **Upstream sync cadence**: Monthly routine sync, immediate for security fixes
- **Diff visibility**: `git diff upstream-tracking...vibectl-main` shows the exact fork diff
- **Conflict resolution**: Temporary `sync/upstream-YYYY-MM-DD` branches for merge conflicts

## Applied Patches

### Minimally Patched Files (3 files, 42 lines net change)

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

**What changed**: Added `getRawContext()` helper that checks for `VIBECTL_CONTEXT_JSON` env var first. If set, parses the JSON to construct the context object (same shape as `@actions/github` context: `eventName`, `payload`, `repo`, `actor`). If not set, falls through to `github.context` (original behavior). Also changed `GITHUB_RUN_ID` from non-null assertion (`!`) to fallback (`|| "0"`) for safety in non-Actions contexts.

**Lines changed**: +25/-2 (23 net)

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

**Re-application after upstream sync**: Add `getRawContext()` function before `parseGitHubContext()` and replace `github.context` reference with `getRawContext()` call. Change `process.env.GITHUB_RUN_ID!` to `process.env.GITHUB_RUN_ID || "0"`.

**Tests**: `test/vibectl/context-fallback.test.ts` — verifies issue_comment and pull_request context construction from JSON, fallback runId, and input env var reading.

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

## Planned Modifications (Future Phases)

### Replaced Files

| File Path                | Original LOC | Replacement LOC (est.) | Reason                                                                                                                                                                                        | Re-application                                                                                                                            |
| ------------------------ | ------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/entrypoints/run.ts` | 315          | ~150                   | CCA's unified orchestrator is tightly coupled to GitHub Actions lifecycle (`@actions/core`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`). vibectl's entry point bridges task queue to CCA execution. | Re-compose from CCA internals: import `detectMode`, `prepareTagMode`, `prepareAgentMode`, `runClaude` and compose with vibectl lifecycle. |
| `src/github/token.ts`    | 151          | ~40                    | CCA's OIDC-to-Anthropic exchange replaced by vibectl's installation token injection.                                                                                                          | Read `GITHUB_TOKEN` from env (set by vibectl runner worker). Much simpler than original.                                                  |

### vibectl-Specific Additions

| File Path                       | Est. LOC | Purpose                                                                            | Re-application                        |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------- | ------------------------------------- |
| `src/vibectl/entry-adapter.ts`  | ~100     | Bridges vibectl task dispatch payload to CCA execution                             | Self-contained file; no conflict risk |
| `src/vibectl/output-scanner.ts` | ~50      | Applies gitleaks-based output scanning to CCA execution output                     | Self-contained file; no conflict risk |
| `src/vibectl/auth-bridge.ts`    | ~80      | Configures container auth: AI proxy URL, installation token, proxy signing headers | Self-contained file; no conflict risk |

### CI/Configuration Changes

| File Path                  | What Changes                                                  | Re-application                            |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| `.github/workflows/ci.yml` | Fork CI workflow runs CCA test suite on `vibectl-main` branch | Maintained independently from upstream CI |
| `FORK_CHANGES.md`          | This document                                                 | Fork-only file; no conflict risk          |

## Diff Surface Summary

| Metric                               | Value            |
| ------------------------------------ | ---------------- |
| Total CCA source LOC                 | ~8,700           |
| Lines untouched                      | ~7,549 (86.5%)   |
| Lines changed in applied patches     | 42 net (3 files) |
| Lines in replaced files (planned)    | ~466 (5.3%)      |
| New vibectl-specific lines (planned) | ~230             |
| **Total diff surface (projected)**   | **~456 lines**   |

## Merge Conflict Risk Assessment

| CCA Directory            | Conflict Risk | Rationale                                                                    |
| ------------------------ | ------------- | ---------------------------------------------------------------------------- |
| `src/mcp/`               | NONE          | Zero-diff approach: `GITHUB_ACTION_PATH` set by entry adapter env var        |
| `src/entrypoints/`       | LOW           | `run.ts` replaced (no conflict); `collect-inputs.ts` small patch (+13 lines) |
| `src/github/`            | HIGH          | `context.ts` has high upstream churn and receives a +23 line patch           |
| `src/github/operations/` | NONE          | Zero-diff approach: `GITHUB_SERVER_URL` already has default in `config.ts`   |
| `src/modes/`             | NONE          | No vibectl modifications                                                     |
| `src/create-prompt/`     | NONE          | No vibectl modifications                                                     |
| `base-action/src/`       | NONE          | No vibectl modifications                                                     |
