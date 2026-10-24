// Third-party imports
import { Effect, Schema } from 'effect';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

// Local imports - shared state
import { PersistedState } from '@texra/shared/state/PersistedState';

const StateSchema = Schema.Struct({
  density: Schema.Literals(['compact', 'comfortable']).pipe(
    Schema.withDecodingDefault(Effect.succeed('comfortable')),
  ),
});

describe('PersistedState loading', () => {
  const storage = {
    get: vi.fn(),
    update: vi.fn<(key: string, value: unknown) => void>(),
  };

  let warn: MockInstance<typeof console.warn>;

  beforeEach(() => {
    vi.clearAllMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
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
