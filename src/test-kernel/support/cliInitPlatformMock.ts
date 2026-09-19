// Third-party imports
import { vi } from 'vitest';

import { testRuntime } from './testProcessRuntime';

/**
 * Shared mock for the CLI composition root that command suites stub
 * identically: `initCliPlatform` (now an Effect the command's own program
 * yields) and the process-runtime install every command entry awaits before
 * it runs that program. The mock bag and the two `vi.mock` registrations live
 * here instead of being re-declared per suite.
 *
 * Importing this module registers the mocks for the importing suite. Vitest
 * gives each test file a fresh module graph, so the singleton bag is
 * per-suite at runtime — clear it in the suite's own `beforeEach`
 * (`vi.clearAllMocks()` covers it; it keeps the default implementation below).
 *
 * Ordering: the `vi.mock` calls below register when this module evaluates, so
 * the import must precede anything that could load either module (see
 * `agentCatalogMock` for the idiom). The bag is `vi.hoisted`, so the mock
 * factories can never observe it uninitialized.
 */
const cliInitPlatformMock = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: cliInitPlatformMock.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', async () => {
  const { Effect } = await import('effect');
  return {
    installCliProcessRuntime: cliInitPlatformMock.installCliProcessRuntime,
    disposeCliProcessRuntime: Effect.void,
  };
});

// The harness's own runtime, read at call time: `installFakeHost` builds it
// before each test, so the default cannot capture one at registration.
cliInitPlatformMock.installCliProcessRuntime.mockImplementation(async () =>
  testRuntime(),
);

export { cliInitPlatformMock };
