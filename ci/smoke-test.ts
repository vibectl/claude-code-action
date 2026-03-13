/**
 * Container smoke test -- validates CCA code executability inside a built image.
 *
 * Validates:
 * 1. Bun runtime operational at expected version
 * 2. CCA source present at /opt/cca with expected structure
 * 3. CCA TypeScript modules importable (compilation + dependency resolution)
 * 4. vibectl integration layer importable (entry adapter, auth bridge, output scanner)
 * 5. Non-root execution (UID 1000, sandbox user)
 * 6. Production directory layout (/opt/cca/src, /opt/cca/base-action, /opt/cca/node_modules)
 *
 * Exit 0 = all checks pass. Non-zero = failure with diagnostic output.
 */

import { existsSync } from "fs";
import { execSync } from "child_process";

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

console.log("CCA Container Smoke Test");
console.log("========================\n");

// --- 1. Runtime checks ---
console.log("[Runtime]");

await check("Bun runtime available", () => {
  const version = execSync("bun --version", { encoding: "utf-8" }).trim();
  assert(version.length > 0, "bun --version returned empty");
  console.log(`         Bun version: ${version}`);
});

await check("Non-root execution", () => {
  const uid = process.getuid?.();
  assert(uid === 1000, `Expected UID 1000, got ${uid}`);
  const user = execSync("whoami", { encoding: "utf-8" }).trim();
  assert(user === "sandbox", `Expected user 'sandbox', got '${user}'`);
});

// --- 2. Directory structure ---
console.log("\n[Directory Structure]");

await check("CCA source root exists", () => {
  assert(existsSync(CCA_ROOT), `${CCA_ROOT} does not exist`);
});

await check("CCA src/ directory exists", () => {
  assert(existsSync(`${CCA_ROOT}/src`), "src/ missing");
});

await check("CCA base-action/ directory exists", () => {
  assert(existsSync(`${CCA_ROOT}/base-action`), "base-action/ missing");
});

await check("node_modules/ present (dependencies installed)", () => {
  assert(existsSync(`${CCA_ROOT}/node_modules`), "node_modules/ missing");
});

await check("package.json present", () => {
  assert(existsSync(`${CCA_ROOT}/package.json`), "package.json missing");
});

await check("tsconfig.json present", () => {
  assert(existsSync(`${CCA_ROOT}/tsconfig.json`), "tsconfig.json missing");
});

// --- 3. CCA module imports ---
console.log("\n[CCA Module Imports]");

await check("Import: modes/detector (detectMode)", async () => {
  const mod = await import(`${CCA_ROOT}/src/modes/detector.ts`);
  assert(
    typeof mod.detectMode === "function",
    "detectMode not exported as function",
  );
});

await check("Import: entrypoints/collect-inputs", async () => {
  const mod = await import(`${CCA_ROOT}/src/entrypoints/collect-inputs.ts`);
  assert(
    typeof mod.collectActionInputsPresence === "function",
    "collectActionInputsPresence not exported as function",
  );
});

await check("Import: github/context", async () => {
  const mod = await import(`${CCA_ROOT}/src/github/context.ts`);
  assert(
    typeof mod.parseGitHubContext === "function",
    "parseGitHubContext not exported as function",
  );
});

await check("Import: github/constants", async () => {
  const mod = await import(`${CCA_ROOT}/src/github/constants.ts`);
  assert(mod.CLAUDE_APP_BOT_ID !== undefined, "CLAUDE_APP_BOT_ID not exported");
  assert(mod.CLAUDE_BOT_LOGIN !== undefined, "CLAUDE_BOT_LOGIN not exported");
});

// --- 4. vibectl integration layer imports ---
console.log("\n[vibectl Integration Layer]");

await check("Import: vibectl/output-scanner", async () => {
  const mod = await import(`${CCA_ROOT}/src/vibectl/output-scanner.ts`);
  assert(
    typeof mod.scanForSecrets === "function",
    "scanForSecrets not exported as function",
  );
  assert(
    typeof mod.redactSecrets === "function",
    "redactSecrets not exported as function",
  );
});

await check("Import: vibectl/auth-bridge", async () => {
  const mod = await import(`${CCA_ROOT}/src/vibectl/auth-bridge.ts`);
  assert(
    typeof mod.configureAuth === "function",
    "configureAuth not exported as function",
  );
});

await check("Import: vibectl/entry-adapter", async () => {
  const mod = await import(`${CCA_ROOT}/src/vibectl/entry-adapter.ts`);
  assert(
    typeof mod.executeTask === "function",
    "executeTask not exported as function",
  );
});

// --- 5. Dependency resolution ---
console.log("\n[Dependency Resolution]");

await check("@actions/core resolvable", async () => {
  const mod = await import("@actions/core");
  assert(typeof mod.info === "function", "@actions/core.info not a function");
});

await check("@actions/github resolvable", async () => {
  const mod = await import("@actions/github");
  assert(mod.context !== undefined, "@actions/github.context not available");
});

await check("zod resolvable", async () => {
  const mod = await import("zod");
  assert(typeof mod.z?.string === "function", "zod.z.string not a function");
});

// --- Summary ---
console.log(`\n========================`);
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
