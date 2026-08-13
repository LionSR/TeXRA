// Third-party imports
import { onTestFinished, vi } from 'vitest';

type ModuleMockFactory = Parameters<typeof vi.doMock>[1];

interface ModuleMocks {
  /**
   * Installs a module mock and unmocks that specifier when the running test
   * finishes. Re-mocking the same specifier within one test is deduped.
   */
  doMock(specifier: string, factory: ModuleMockFactory): void;
  /** Drops a mock mid-test so the next dynamic import sees the real module. */
  doUnmock(specifier: string): void;
}

/**
 * Per-suite recorder for `vi.doMock` specifiers.
 *
 * A suite that mocks in a loader helper and unmocks from a hand-written
 * `afterEach` list owns the same specifier list twice, and the two drift the
 * moment a mock is added, renamed, or removed. Recording the specifier at the
 * mock site keeps teardown exact, and pins it to `onTestFinished` so suites
 * share one teardown idiom with `disposeAfterTest`.
 */
export function createModuleMocks(): ModuleMocks {
  let mockedInTest: Set<string> | undefined;

  function trackForTeardown(): Set<string> {
    if (mockedInTest) return mockedInTest;
    const specifiers = new Set<string>();
    mockedInTest = specifiers;
    onTestFinished(() => {
      mockedInTest = undefined;
      for (const specifier of specifiers) vi.doUnmock(specifier);
    });
    return specifiers;
  }

  return {
    doMock(specifier, factory) {
      trackForTeardown().add(specifier);
      vi.doMock(specifier, factory);
    },
    doUnmock(specifier) {
      mockedInTest?.delete(specifier);
      vi.doUnmock(specifier);
    },
  };
}
