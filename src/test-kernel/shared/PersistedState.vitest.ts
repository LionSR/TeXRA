// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

// Local imports - shared state
import { PersistedState } from '@shared/state/PersistedState';

const StateSchema = z.object({
  density: z.enum(['compact', 'comfortable']).prefault('comfortable'),
});

describe('PersistedState loading', () => {
  const set = vi.fn();
  const storage = {
    get: vi.fn(),
    set,
    delete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses schema defaults silently when the key has never been stored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    storage.get.mockReturnValue(undefined);

    const state = new PersistedState(storage, 'viewPrefs', StateSchema);

    expect(state.getState()).toEqual({ density: 'comfortable' });
    expect(set).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and replaces a malformed stored value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    storage.get.mockReturnValue({ density: 'broken' });

    const state = new PersistedState(storage, 'viewPrefs', StateSchema);

    expect(state.getState()).toEqual({ density: 'comfortable' });
    expect(set).toHaveBeenCalledWith('viewPrefs', {
      density: 'comfortable',
    });
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
