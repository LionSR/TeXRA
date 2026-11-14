import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(
  new URL('../../../../packages/harness/package.json', import.meta.url),
);
export const load = (name) => import(pathToFileURL(require.resolve(name)).href);
export const E = await load('effect');
