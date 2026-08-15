/**
 * Shared fixtures for `@agent/storage` test doubles.
 */

/**
 * The canonical durable-finalization result most storage-mocking suites
 * resolve `finalizeExecution` with: terminal status persisted, flow record
 * gone. Returned fresh per call so a suite can mutate its copy.
 *
 * The shape is shared verbatim — including the legacy `terminalStatusPersisted`
 * key the mocks have always carried — so consumers observe exactly what the
 * pre-consolidation literals produced.
 */
export function durableFinalizationResult() {
  return {
    status: 'durable',
    terminalStatusPersisted: true,
    flowRecord: 'deleted',
  } as const;
}
