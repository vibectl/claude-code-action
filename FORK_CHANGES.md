# vibectl Fork Changes

This document tracks all modifications made to the vibectl fork of
[anthropics/claude-code-action](https://github.com/anthropics/claude-code-action),
per the fork governance model.

## Branch Structure

| Branch | Purpose | Update Mechanism |
|--------|---------|-----------------|
| `upstream-tracking` | Clean mirror of upstream `main` | Automated sync (daily fetch) |
| `vibectl-main` | Production branch with vibectl additions | Upstream sync merge + vibectl changes |

## Fork Governance

- **Upstream sync cadence**: Monthly routine sync, immediate for security fixes
- **Diff visibility**: `git diff upstream-tracking...vibectl-main` shows the exact fork diff
- **Conflict resolution**: Temporary `sync/upstream-YYYY-MM-DD` branches for merge conflicts

## Planned Modifications

### Replaced Files

| File Path | Original LOC | Replacement LOC (est.) | Reason | Re-application |
|-----------|-------------|----------------------|--------|----------------|
| `src/entrypoints/run.ts` | 315 | ~150 | CCA's unified orchestrator is tightly coupled to GitHub Actions lifecycle (`@actions/core`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`). vibectl's entry point bridges task queue to CCA execution. | Re-compose from CCA internals: import `detectMode`, `prepareTagMode`, `prepareAgentMode`, `runClaude` and compose with vibectl lifecycle. |
| `src/github/token.ts` | 151 | ~40 | CCA's OIDC-to-Anthropic exchange replaced by vibectl's installation token injection. | Read `GITHUB_TOKEN` from env (set by vibectl runner worker). Much simpler than original. |

### Minimally Patched Files

| File Path | LOC | What Changes | Est. Lines | Re-application |
|-----------|-----|-------------|-----------|----------------|
| `src/entrypoints/collect-inputs.ts` | 54 | Add fallback: if `ALL_INPUTS` env var not set, read from task payload JSON file | ~8 | Add `else` branch reading from `/tmp/vibectl-task-config.json` |
| `src/github/context.ts` | 301 | Add alternative constructor: if `@actions/github` context unavailable, construct from task payload JSON | ~15 | Add conditional block at top of `getContext()` checking for `VIBECTL_CONTEXT_JSON` env var |
| `src/github/constants.ts` | 14 | Read bot ID and login from env vars with CCA defaults as fallback | ~5 | Replace hardcoded values with `process.env.BOT_USER_ID ?? "41898282"` pattern |
| `src/github/operations/git-config.ts` | 113 | Ensure `GITHUB_SERVER_URL` available in container | ~0-5 | Env var set by entry adapter; may need no code change |
| `src/mcp/install-mcp-server.ts` | 230 | Make script path prefix configurable (replace `GITHUB_ACTION_PATH`) | ~8 | Replace `GITHUB_ACTION_PATH` reference with `process.env.CCA_SOURCE_PATH ?? process.env.GITHUB_ACTION_PATH` |

### vibectl-Specific Additions

| File Path | Est. LOC | Purpose | Re-application |
|-----------|---------|---------|----------------|
| `src/vibectl/entry-adapter.ts` | ~100 | Bridges vibectl task dispatch payload to CCA execution | Self-contained file; no conflict risk |
| `src/vibectl/output-scanner.ts` | ~50 | Applies gitleaks-based output scanning to CCA execution output | Self-contained file; no conflict risk |
| `src/vibectl/auth-bridge.ts` | ~80 | Configures container auth: AI proxy URL, installation token, proxy signing headers | Self-contained file; no conflict risk |

### CI/Configuration Changes

| File Path | What Changes | Re-application |
|-----------|-------------|----------------|
| `.github/workflows/ci.yml` | Fork CI workflow runs CCA test suite on `vibectl-main` branch | Maintained independently from upstream CI |
| `FORK_CHANGES.md` | This document | Fork-only file; no conflict risk |

## Diff Surface Summary

| Metric | Value |
|--------|-------|
| Total CCA source LOC | ~8,700 |
| Lines untouched | ~7,549 (86.5%) |
| Estimated lines changed in patches | ~36 (0.4%) |
| Lines in replaced files | ~466 (5.3%) |
| New vibectl-specific lines | ~230 |
| **Total diff surface** | **~456 lines** |

## Merge Conflict Risk Assessment

| CCA Directory | Conflict Risk | Rationale |
|--------------|--------------|-----------|
| `src/mcp/` | LOW | 4 server files untouched; only `install-mcp-server.ts` patched (~8 lines) |
| `src/entrypoints/` | LOW | `run.ts` replaced (no conflict); `collect-inputs.ts` small patch |
| `src/github/` | HIGH | `context.ts` has high upstream churn and receives a ~15 line patch |
| `src/github/operations/` | LOW | `git-config.ts` patch minimal; other files untouched |
| `src/modes/` | NONE | No vibectl modifications |
| `src/create-prompt/` | NONE | No vibectl modifications |
| `base-action/src/` | NONE | No vibectl modifications |
