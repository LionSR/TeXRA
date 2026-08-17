// Third-party imports
import { vi } from 'vitest';

/**
 * Shared mock for the `@agent/index` agent-catalog surface that CLI command
 * suites stub identically: the mock bag and the `vi.mock` registration live
 * here instead of being re-declared per suite.
 *
 * Importing this module registers the mock for the importing suite. The bag
 * is the union of the members the migrated suites stub; members a suite never
 * drives simply stay unconfigured. Vitest gives each test file a fresh module
 * graph, so the singleton bag is per-suite at runtime — reset it in the
 * suite's own `beforeEach` (or via `vi.clearAllMocks()`) like a local bag.
 *
 * Ordering: the `vi.mock` below registers when this module evaluates, so the
 * import must precede anything that could load `@agent/index`. Suites that
 * `await import()` the command under test get that for free; suites with
 * static imports keep this import immediately after the vitest import (see
 * `AgentResolution.vitest.ts`) — a convention the
 * `supportMockImportOrder.vitest.ts` architecture test enforces. The bag is
 * `vi.hoisted`, so the mock factory can never observe it uninitialized.
 */
const agentCatalogMock = vi.hoisted(() => ({
  getAgent: vi.fn(),
  getAgentsByCategory: vi.fn(),
  getVisibleAgents: vi.fn(),
  getCustomAgentScanIssues: vi.fn(() => []),
  loadAgents: vi.fn(),
  refresh: vi.fn(),
  resolveAgentForLaunch: vi.fn(),
}));

vi.mock('@agent/index', () => ({ ...agentCatalogMock }));

export { agentCatalogMock };
