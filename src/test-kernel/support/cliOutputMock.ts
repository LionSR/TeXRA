// Third-party imports
import { vi } from 'vitest';

/**
 * Shared mock for the `@cli/commands/_helpers/output` result emitter that CLI
 * command suites stub identically: the mock bag and the `vi.mock`
 * registration live here instead of being re-declared per suite.
 *
 * Importing this module registers the mock for the importing suite. Vitest
 * gives each test file a fresh module graph, so the singleton bag is
 * per-suite at runtime — clear it in the suite's own `beforeEach`
 * (`vi.clearAllMocks()` covers it).
 *
 * Ordering: this module must evaluate before anything that loads
 * `@cli/commands/_helpers/output` (see `agentCatalogMock` for the idiom).
 */
export const cliOutputMock = {
  emitCliResult: vi.fn(),
};

vi.mock('@cli/commands/_helpers/output', () => ({ ...cliOutputMock }));
