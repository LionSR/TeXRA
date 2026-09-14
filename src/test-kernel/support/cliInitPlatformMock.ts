// Third-party imports
import { vi } from 'vitest';

// Local imports
import { effectRuntime } from '@platform/processRuntime';

/**
 * Shared mock for the `@cli/runtime/initPlatform` initializers that CLI
 * command suites stub identically: the mock bag and the `vi.mock`
 * registration live here instead of being re-declared per suite.
 *
 * Importing this module registers the mock for the importing suite. Vitest
 * gives each test file a fresh module graph, so the singleton bag is
 * per-suite at runtime — clear it in the suite's own `beforeEach`
 * (`vi.clearAllMocks()` covers it).
 *
 * Ordering: the `vi.mock` below registers when this module evaluates, so the
 * import must precede anything that could load `@cli/runtime/initPlatform`
 * (see `agentCatalogMock` for the idiom). The bag is `vi.hoisted`, so the
 * mock factory can never observe it uninitialized.
 */
const cliInitPlatformMock = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  initLocalCliPlatform: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({ ...cliInitPlatformMock }));

// Every command reads `runtime` off the services its init returns, so the
// stub hands back the kernel harness's own process runtime by default. A
// suite that needs more (stores, a session) resolves its own bag and keeps
// this field in it.
for (const init of [
  cliInitPlatformMock.initCliPlatform,
  cliInitPlatformMock.initLocalCliPlatform,
]) {
  init.mockImplementation(async () => ({ runtime: effectRuntime() }));
}

export { cliInitPlatformMock };
