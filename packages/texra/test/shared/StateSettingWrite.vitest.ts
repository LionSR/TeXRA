// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { applyStateSettingUpdate } from '@texra/shared/settingsView/handlers/stateSettingWrite';
import { LATEX_FORMATTER_SETTING } from '@texra/shared/settingsView/texraSettings';

describe('applyStateSettingUpdate', () => {
  it.effect('uses null as an explicit reset and omission as a no-op', () =>
    Effect.gen(function* () {
      const fake = makeFakeSettingsStores();
      const ports = { stores: fake.stores, host: 'settingsView' as const };

      yield* applyStateSettingUpdate(
        LATEX_FORMATTER_SETTING.key,
        'latexindent',
        ports,
      );
      expect(
        yield* fake.workspaceState.get(LATEX_FORMATTER_SETTING.key),
      ).toBeDefined();

      expect(
        yield* applyStateSettingUpdate(
          LATEX_FORMATTER_SETTING.key,
          null,
          ports,
        ),
      ).toMatchObject({ kind: 'applied' });
      expect(
        yield* fake.workspaceState.get(LATEX_FORMATTER_SETTING.key),
      ).toBeUndefined();

      // A value-less message is a no-op: the catalog schemas carry a decoding
      // default, so parsing `undefined` would silently write a default.
      expect(
        yield* applyStateSettingUpdate(
          LATEX_FORMATTER_SETTING.key,
          undefined,
          ports,
        ),
      ).toEqual({ kind: 'ignored' });
    }),
  );
});
