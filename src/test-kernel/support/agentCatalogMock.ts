// Third-party imports
import { vi } from 'vitest';

/**
 * Shared mock for the `@agent/index` agent-catalog surface that CLI command
 * suites stub identically: the mock bag, the `vi.mock` registration, and the
 * reset ritual live here instead of being re-declared per suite.
 *
 * Importing this module registers the mock for the importing suite. The bag
 * is the union of the members the migrated suites stub; members a suite never
 * drives simply stay unconfigured. Vitest gives each test file a fresh module
 * graph, so the singleton bag is per-suite at runtime — reset it in the
 * suite's own `beforeEach` (or via `vi.clearAllMocks()`) like a local bag.
 *
 * Ordering: this module must evaluate before anything that loads
 * `@agent/index`. Suites that `await import()` the command under test get
 * that for free; suites that import the module under test statically must
 * import this module first (see `defaultSessionTestSetup` for the idiom).
 */
export const agentCatalogMock = {
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  loadAgents: vi.fn(),
  refresh: vi.fn(),
  resolveAgentForLaunch: vi.fn(),
};

vi.mock('@agent/index', () => ({ ...agentCatalogMock }));

/** Resets every catalog mock — implementations included — for test isolation. */
export function resetAgentCatalogMock(): void {
  for (const mock of Object.values(agentCatalogMock)) mock.mockReset();
}
