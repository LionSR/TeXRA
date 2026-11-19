// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { AppSignals } from '@texra-ai/harness/plugins';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { applyStateSettingUpdate } from '@texra/controllers/settingsView/stateSettingWrite';
import { LATEX_FORMATTER_SETTING } from '@texra/shared/settings/texraSettings';

describe('applyStateSettingUpdate', () => {
  it.effect('uses null as an explicit reset and omission as a no-op', () =>
    Effect.gen(function* () {
      const fake = makeFakeSettingsStores();
      const roots = { ...fake.stores, workspace: '/workspace' };

      yield* applyStateSettingUpdate(
        LATEX_FORMATTER_SETTING,
        'latexindent',
        roots,
      );
      expect(
        yield* fake.workspaceState.get(LATEX_FORMATTER_SETTING.key),
      ).toBeDefined();

      expect(
        yield* applyStateSettingUpdate(LATEX_FORMATTER_SETTING, null, roots),
      ).toMatchObject({ kind: 'applied' });
      expect(
        yield* fake.workspaceState.get(LATEX_FORMATTER_SETTING.key),
      ).toBeUndefined();

      // A value-less message is a no-op: the catalog schemas carry a decoding
      // default, so parsing `undefined` would silently write a default.
      expect(
        yield* applyStateSettingUpdate(
          LATEX_FORMATTER_SETTING,
          undefined,
          roots,
        ),
      ).toEqual({ kind: 'ignored' });
    }).pipe(Effect.provide(AppSignals.layer)),
  );
});
