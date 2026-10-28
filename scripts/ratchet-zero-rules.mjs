// Rules held at zero with no baseline file. A rule nobody may break any more
// is a lint error or a hard-coded zero in its checker, not an empty baseline
// that a second checker also reads. Each key is the baseline file the rule
// once had; the value names the one place that now fails a site.
//
// check-ratchet-baselines.mjs lets a baseline file be deleted only when it
// was empty at the merge base and is listed here, and fails a listed file
// that still exists. check-core-quality.mjs holds every core-quality rule
// listed here at zero.
export const ZERO_RULES = Object.freeze({
  'config/ratchets/core-quality/durable-invariants.json':
    'scripts/check-core-quality.mjs',
  'config/ratchets/core-quality/effect-run.json':
    'eslint.config.mjs, no-restricted-syntax over the core',
  'config/ratchets/core-quality/import-cycles.json':
    'scripts/check-core-quality.mjs',
  'config/ratchets/core-quality/new-promise.json':
    'eslint.config.mjs, no-restricted-syntax over the core',
  'config/ratchets/core-quality/no-explicit-any.json':
    'eslint.config.mjs, @typescript-eslint/no-explicit-any over the core',
  'config/ratchets/core-quality/promise-then.json':
    'eslint.config.mjs, no-restricted-syntax over the core',
  'config/ratchets/core-quality/try-catch-effect.json':
    'scripts/check-core-quality.mjs',
  'config/ratchets/forgotten-exports.json':
    'packages/harness/scripts/forgotten-exports.mjs',
  // Its sites are core-module-mocks rows, which keep their own baseline.
  'config/ratchets/host-agent-mock-baseline.json':
    'scripts/check-core-quality.mjs, core-module-mocks',
});
