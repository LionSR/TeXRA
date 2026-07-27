// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import {
  getServerSideKeyService,
  resetServerSideKeyServiceForTests,
} from '@auth/serverKeys';
import type { StateStore } from '@platform/interfaces';
import { FakeStateStore } from '@test/support/FakePlatform';

// Controllable stand-in for the platform state store so the test can move
// through "before initPlatform()" -> "after initPlatform()" without booting a
// real platform.
const platformState = vi.hoisted(() => ({
  store: null as StateStore | null,
}));

vi.mock('@platform/platform', () => ({
  tryGlobalState: () => platformState.store,
}));

describe('getServerSideKeyService singleton', () => {
  afterEach(() => {
    resetServerSideKeyServiceForTests();
  });

  it('rebuilds a stateless instance once platform state appears', () => {
    // Constructed before initPlatform(): no state store.
    platformState.store = null;
    const stateless = getServerSideKeyService();
    expect(stateless.getUseIncludedModelAccess()).toBe(false);

    // Embedder path: state never appears -> the stateless instance is kept.
    expect(getServerSideKeyService()).toBe(stateless);

    // Host path: initPlatform() ran after the first access -> rebuild so the
    // preference can be read instead of serving the stateless zombie forever.
    platformState.store = new FakeStateStore({
      'texra.useIncludedModelAccess': true,
    });
    const stateful = getServerSideKeyService();
    expect(stateful).not.toBe(stateless);
    expect(stateful.getUseIncludedModelAccess()).toBe(true);

    // The rebuilt instance is now stable.
    expect(getServerSideKeyService()).toBe(stateful);
  });
});
