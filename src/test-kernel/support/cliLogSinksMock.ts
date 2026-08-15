// Third-party imports
import { vi } from 'vitest';

/**
 * Shared mock for the `@cli/runtime/logSinks` stderr/stdout writers that CLI
 * command suites stub identically: the mock bag and the `vi.mock`
 * registration live here instead of being re-declared per suite.
 *
 * Importing this module registers the mock for the importing suite. The bag
 * is the union of the writers the migrated suites stub; writers a suite never
 * drives simply stay unconfigured. Vitest gives each test file a fresh module
 * graph, so the singleton bag is per-suite at runtime — clear it in the
 * suite's own `beforeEach` (`vi.clearAllMocks()` covers it, and preserves the
 * `writeTextStderrAndWait` default implementation).
 *
 * Ordering: the `vi.mock` below registers when this module evaluates, so the
 * import must precede anything that could load `@cli/runtime/logSinks` (see
 * `agentCatalogMock` for the idiom). The bag is `vi.hoisted`, so the mock
 * factory can never observe it uninitialized.
 */
const cliLogSinksMock = vi.hoisted(() => ({
  writeErrorStderr: vi.fn(),
  writeNdjsonStdout: vi.fn(),
  writeTextStderr: vi.fn(),
  writeTextStderrAndWait: vi.fn(async () => undefined),
  writeTextStdout: vi.fn(),
}));

vi.mock('@cli/runtime/logSinks', () => ({ ...cliLogSinksMock }));

export { cliLogSinksMock };
