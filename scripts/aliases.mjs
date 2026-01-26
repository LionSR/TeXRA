/**
 * Shared path aliases derived from tsconfig.json.
 * Single source of truth for esbuild and Vite build configs.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

// Parse tsconfig.json (strip comments for JSON.parse compatibility)
const tsconfigPath = resolve(rootDir, 'tsconfig.json');
const tsconfigText = readFileSync(tsconfigPath, 'utf8');

// Strip JSON comments - process character by character to handle strings correctly
function stripJsonComments(text) {
  let result = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const char = text[i];
    const next = text[i + 1];

    // Handle string literals
    if (char === '"' && (i === 0 || text[i - 1] !== '\\')) {
      inString = !inString;
      result += char;
      i++;
      continue;
    }

    if (!inString) {
      // Skip line comments
      if (char === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      // Skip block comments
      if (char === '/' && next === '*') {
        i += 2;
        while (i < text.length - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
    }

    result += char;
    i++;
  }

  // Remove trailing commas
  return result.replace(/,(\s*[}\]])/g, '$1');
}

const tsconfigJson = stripJsonComments(tsconfigText);
const tsconfig = JSON.parse(tsconfigJson);

/**
 * Convert tsconfig paths to build tool aliases.
 *
 * tsconfig format: { "@alias/*": ["src/path/*"] }
 * output format:   { "@alias": "/absolute/path/to/src/path" }
 */
export const aliases = Object.fromEntries(
  Object.entries(tsconfig.compilerOptions.paths).map(([key, values]) => {
    // Remove trailing /* from alias key
    const aliasKey = key.replace('/*', '');
    // Get first path value and remove trailing /*
    const pathValue = values[0].replace('/*', '');
    // Resolve to absolute path
    return [aliasKey, resolve(rootDir, pathValue)];
  })
);

/**
 * Root directory of the project.
 */
export { rootDir };
