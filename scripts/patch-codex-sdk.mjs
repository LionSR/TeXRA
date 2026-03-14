/**
 * Postinstall patch for @openai/codex-sdk.
 *
 * The SDK v0.114.0 hardcodes `--experimental-json` but the CLI v0.114.0
 * renamed it to `--json`.  This one-liner fixes the mismatch so that
 * `codex exec` doesn't reject the unknown flag.
 *
 * Safe to remove once @openai/codex-sdk ships a version that uses `--json`.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'node_modules', '@openai', 'codex-sdk', 'dist', 'index.js');

if (!existsSync(target)) {
  // SDK not installed — nothing to patch
  process.exit(0);
}

const src = readFileSync(target, 'utf8');
if (!src.includes('"--experimental-json"')) {
  // Already patched or SDK updated — nothing to do
  process.exit(0);
}

writeFileSync(target, src.replace('"--experimental-json"', '"--json"'));
console.log('[patch-codex-sdk] Replaced --experimental-json with --json');
