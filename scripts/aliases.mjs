/**
 * Shared path aliases derived from tsconfig.json for the Vite, Vitest and
 * oxlint configs, and the shared `dedupe` list for Vite build configs.
 * Extension esbuild reads its package tsconfig, which extends the root.
 */

import { resolve } from 'node:path';

import { loadAliases } from './aliasUtils.mjs';

const rootDir = resolve(import.meta.dirname, '..');

/**
 * Convert tsconfig paths to build tool aliases.
 *
 * tsconfig format: { "@alias/*": ["src/path/*"] }
 * output format:   { "@alias": "/absolute/path/to/src/path" }
 */
export const aliases = Object.freeze(loadAliases(rootDir));

/**
 * Packages a Vite build resolves from the project root, so the sources it
 * pulls in from several workspace packages share one copy: Web Awesome and
 * Lit define their custom elements once, and the signals share one graph.
 */
export const dedupe = Object.freeze([
  '@awesome.me/webawesome',
  '@lit-labs/signals',
  'lit',
  'signal-polyfill',
]);

/**
 * Root directory of the project.
 */
export { rootDir };
