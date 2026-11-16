/**
 * Bundles a module under `scripts/fixtures/` (a list of production exports a
 * script drives) into one ESM file and imports it. Node cannot load the
 * root's aliased TypeScript sources directly; the bundle resolves the
 * aliases through the root `tsconfig.json`.
 */

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

import { esmCjsGlobalsBanner } from './esm-cjs-globals-banner.mjs';

const root = join(import.meta.dirname, '..');

/**
 * @param {string} name the fixture module's name under `scripts/fixtures/`
 * @param {string} outfile where the bundle is written
 */
export async function bundleFixture(name, outfile) {
  await build({
    entryPoints: [join(root, 'scripts', 'fixtures', `${name}.ts`)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.16',
    tsconfig: join(root, 'tsconfig.json'),
    logLevel: 'warning',
    // macOS's native file watcher, an optional dependency of a watcher the
    // session database bundle reaches; a `.node` binary cannot be bundled.
    external: ['fsevents'],
    banner: { js: esmCjsGlobalsBanner },
  });
  return import(pathToFileURL(outfile).href);
}
