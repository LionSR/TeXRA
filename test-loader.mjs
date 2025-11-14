/**
 * ESM loader to register tsconfig-paths before tests run
 * This runs at the Node.js loader level, before Mocha initializes
 */
import { register, loadConfig } from 'tsconfig-paths';
import { resolve } from 'path';
import { pathToFileURL } from 'url';

const projectRoot = process.cwd();
const tsConfigResult = loadConfig(projectRoot);

if (tsConfigResult.resultType === 'success') {
  // Adjust paths to point to 'out' directory instead of 'src'
  const adjustedPaths = {};
  for (const [key, value] of Object.entries(tsConfigResult.paths)) {
    adjustedPaths[key] = value.map((p) => p.replace(/^src\//, 'out/'));
  }

  register({
    baseUrl: tsConfigResult.absoluteBaseUrl,
    paths: adjustedPaths,
  });
}

// Re-export hooks to satisfy Node's loader API
export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context);
}
