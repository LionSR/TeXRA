/**
 * Shared fixtures for `@agent/storage` test doubles.
 */

/**
 * The canonical durable-finalization result most storage-mocking suites
 * resolve `finalizeRun` with. Returned fresh per call so a suite can mutate
 * its copy.
 */
export function durableFinalizationResult() {
  return { ok: true } as const;
}
