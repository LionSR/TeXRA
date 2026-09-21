/**
 * The `live` project: one suite per HTTP protocol, run against the real
 * provider.
 *
 * It is a separate config, not a third project in the root `vitest.config.mjs`,
 * because nothing here shares that file's premises: no alias map, no fake
 * platform, no shared module registry, and no place in `npm test`. The
 * kernel tiers must stay hermetic and free, so the tier that spends money and
 * needs the network is reached only by name (`npm run test:live`) or by the
 * labelled CI job in `.github/workflows/live-llm.yml`.
 *
 * Each suite gates itself on its own key, so a run with one key exercises one
 * protocol and skips the other ten. `vscode-lm`, the twelfth protocol, has no
 * suite here: it is acquired through the extension host's `vscode.lm` API and
 * its live check belongs to an Extension Development Host job.
 */

// Node imports
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { defineConfig } from 'vitest/config';

const packageDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: packageDir,
  test: {
    name: 'live',
    include: ['test-live/**/*.live.ts'],
    // A provider round trip, not a unit test: the budget is one slow route's
    // time to first token plus a whole completion, twice over for the suites
    // that chain a second turn.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
