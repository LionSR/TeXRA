// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { AppSignals, Settings } from '@texra-ai/harness/plugins';
import { DISABLED_SKILLS_SETTING } from '@texra-ai/harness/schemas';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import {
  applyStateSettingUpdate,
  setSkillEnabled,
} from '@texra/controllers/settingsView/stateSettingWrite';
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

  it.effect('toggles a skill over the stored list, not a stale copy', () =>
    Effect.gen(function* () {
      const fake = makeFakeSettingsStores();
      const roots = { ...fake.stores, workspace: '/workspace' };
      // Written after a surface last read the list: a toggle keeps it.
      yield* Settings.set(roots, DISABLED_SKILLS_SETTING, ['first']);

      yield* setSkillEnabled(DISABLED_SKILLS_SETTING, 'second', false, roots);
      expect(yield* Settings.get(roots, DISABLED_SKILLS_SETTING)).toEqual([
        'first',
        'second',
      ]);
      yield* setSkillEnabled(DISABLED_SKILLS_SETTING, 'first', true, roots);
      expect(yield* Settings.get(roots, DISABLED_SKILLS_SETTING)).toEqual([
        'second',
      ]);
    }).pipe(Effect.provide(AppSignals.layer)),
  );
});
