// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';
import { applyStateSettingUpdate } from '@texra/shared/settingsView/handlers/stateSettingWrite';

describe('applyStateSettingUpdate', () => {
  it.effect('uses null as an explicit reset and omission as a no-op', () =>
    Effect.gen(function* () {
      const fake = makeFakeSettingsStores();
      const ports = { stores: fake.stores, host: 'vscode' as const };

      yield* applyStateSettingUpdate(
        TexraStateKey.LATEX_FORMATTER,
        'latexindent',
        ports,
      );
      expect(
        yield* isStored(fake.workspaceState, TexraStateKey.LATEX_FORMATTER),
      ).toBe(true);

      expect(
        yield* applyStateSettingUpdate(
          TexraStateKey.LATEX_FORMATTER,
          null,
          ports,
        ),
      ).toMatchObject({ kind: 'applied' });
      expect(
        yield* isStored(fake.workspaceState, TexraStateKey.LATEX_FORMATTER),
      ).toBe(false);

      // A value-less message is a no-op: the catalog schemas `.prefault()`, so
      // parsing `undefined` would silently write a default.
      expect(
        yield* applyStateSettingUpdate(
          TexraStateKey.LATEX_FORMATTER,
          undefined,
          ports,
        ),
      ).toEqual({ kind: 'ignored' });
    }),
  );
});
