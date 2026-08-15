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
 * Importing this module registers the mock for the importing suite — do not
 * combine it with a suite-local `vi.mock('@agent/storage', ...)` (the two
 * registrations would race). The bag is module-local: suites use the
 * side-effect import and assert through their own `@agent/storage` doubles.
 * Suites needing more than the finalization edge (e.g. `getExecutionStore`)
 * keep their own local mock and use {@link durableFinalizationResult}
 * directly. Vitest gives each test file a
 * fresh module graph, so the singleton bag is per-suite at runtime; the
 * default implementation survives `vi.clearAllMocks()`.
 *
 * Ordering: this module must evaluate before anything that loads
 * `@agent/storage` (see `agentCatalogMock` for the idiom).
 */
const agentStorageFinalizationMock = {
  finalizeExecution: vi.fn(async () => durableFinalizationResult()),
};

vi.mock('@agent/storage', () => ({
  finalizeExecution: agentStorageFinalizationMock.finalizeExecution,
}));
