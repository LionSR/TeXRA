/**
 * Shared path aliases derived from tsconfig.json for the Vite, Vitest and
 * oxlint configs, and the shared `dedupe` list for Vite build configs.
 * Extension esbuild reads its package tsconfig, which extends the root.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAliases } from './aliasUtils.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

/**
 * Convert tsconfig paths to build tool aliases.
 *
 * tsconfig format: { "@alias/*": ["src/path/*"] }
 * output format:   { "@alias": "/absolute/path/to/src/path" }
 */
export const aliases = loadAliases(rootDir);

/**
 * Packages a Vite build resolves from the project root, so the sources it
 * pulls in from several workspace packages share one copy: Web Awesome and
 * Lit define their custom elements once, and the signals share one graph.
 */
export const dedupe = [
  '@awesome.me/webawesome',
  '@lit-labs/signals',
  'lit',
  'signal-polyfill',
];

/**
 * Root directory of the project.
 */
export { rootDir };
