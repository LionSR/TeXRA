// Third-party imports
import { vi } from 'vitest';

// Local imports
import { durableFinalizationResult } from './agentStorageFixtures';

/**
 * Shared mock for the `@agent/storage` finalization edge that run-lifecycle
 * suites stub identically: `finalizeExecution` resolving durable. The mock
 * bag and the `vi.mock` registration live here instead of being re-declared
 * per suite.
 *
 * Importing this module registers the mock for the importing suite. Suites
 * needing only the default durable result use the side-effect import; suites
 * asserting on `finalizeExecution` — or needing more than the finalization
 * edge, e.g. `getExecutionStore` — keep a local `vi.mock('@agent/storage',
 * ...)` (the `WorkflowRunCommand` pattern, using
 * {@link durableFinalizationResult} for the default) and must not import this
 * module: the two registrations would race. Vitest gives each test file a
 * fresh module graph, so the singleton bag is per-suite at runtime; the
 * default implementation survives `vi.clearAllMocks()` but not
 * `mockReset()`/`vi.resetAllMocks()` — a resetting suite must reinstall
 * `mockImplementation(async () => durableFinalizationResult())` first.
 *
 * Ordering: the `vi.mock` below registers when this module evaluates, so the
 * import must precede anything that could load `@agent/storage` (see
 * `agentCatalogMock` for the idiom). The bag is `vi.hoisted`, so the mock
 * factory can never observe it uninitialized.
 */
const agentStorageFinalizationMock = vi.hoisted(() => ({
  finalizeExecution: vi.fn(),
}));

// A hoisted factory cannot close over the imported fixture, so the default
// durable implementation is installed here instead — mockClear (and hence
// vi.clearAllMocks()) preserves it, but mockReset/vi.resetAllMocks() clears
// it; resetting suites must reinstall the implementation above.
agentStorageFinalizationMock.finalizeExecution.mockImplementation(async () =>
  durableFinalizationResult(),
);

vi.mock('@agent/storage', () => ({
  finalizeExecution: agentStorageFinalizationMock.finalizeExecution,
}));
