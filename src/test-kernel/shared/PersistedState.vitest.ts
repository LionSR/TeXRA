// Third-party imports
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import { z } from 'zod';

// Local imports - shared state
import { PersistedState } from '@shared/state/PersistedState';

const StateSchema = z.object({
  density: z.enum(['compact', 'comfortable']).prefault('comfortable'),
});

describe('PersistedState loading', () => {
  const storage = {
    get: vi.fn(),
    update: vi.fn<(key: string, value: unknown) => Promise<void>>(),
  };

  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('uses schema defaults silently when the key has never been stored', () => {
    storage.get.mockReturnValue(undefined);

    const state = new PersistedState(storage, 'viewPrefs', StateSchema);

    expect(state.getState()).toEqual({ density: 'comfortable' });
    expect(storage.update).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns and replaces a malformed stored value', () => {
    storage.get.mockReturnValue({ density: 'broken' });

    const state = new PersistedState(storage, 'viewPrefs', StateSchema);

    expect(state.getState()).toEqual({ density: 'comfortable' });
    expect(storage.update).toHaveBeenCalledWith('viewPrefs', {
      density: 'comfortable',
    });
    expect(warn).toHaveBeenCalledOnce();
  });
});
