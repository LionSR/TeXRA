/**
 * Shared path aliases derived from tsconfig.json for Vite build configs.
 * Extension esbuild reads its generated package tsconfig directly.
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
 * Root directory of the project.
 */
export { rootDir };
