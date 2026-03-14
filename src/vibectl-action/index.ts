/**
 * vibectl GitHub Action entry point.
 *
 * This is the bundled entry point referenced by action.yml (main: dist/index.js).
 * Imports and invokes the run function which handles the full execution flow.
 */

import { run } from "./run.ts";

run();
