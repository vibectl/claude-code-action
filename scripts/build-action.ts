/**
 * Build script for the vibectl GitHub Action.
 *
 * Bundles src/vibectl-action/index.ts into dist/index.js
 * targeting Node 20 for GitHub Actions runtime compatibility.
 */

const result = await Bun.build({
  entrypoints: ["./src/vibectl-action/index.ts"],
  outdir: "./dist",
  target: "node",
  format: "cjs",
  minify: false,
  sourcemap: "none",
  naming: "index.js",
  external: [],
});

if (!result.success) {
  console.error("Build failed:");
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log("Build successful: dist/index.js");
