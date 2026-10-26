// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import {
  isStored,
  makeFakeSettingsStores,
} from '@test/support/settingsStoresFake';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
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
      ).toMatchObject({
        kind: 'applied',
        entry: {
          key: TexraStateKey.LATEX_FORMATTER,
          surfaces: { settingsView: 'latex' },
        },
      });
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

  it.effect(
    'lets CLI /config write its rows that the settings view does not render',
    () =>
      Effect.gen(function* () {
        const fake = makeFakeSettingsStores();
        const key = DocumentsStateKey.LATEXDIFF_TIMEOUT_MS;

        expect(
          yield* applyStateSettingUpdate(key, 20000, {
            stores: fake.stores,
            host: 'cli',
          }),
        ).toMatchObject({ kind: 'applied', entry: { key } });
        expect(yield* fake.workspaceState.get(key)).toBe(20000);
        expect(
          yield* applyStateSettingUpdate(key, null, {
            stores: fake.stores,
            host: 'cli',
          }),
        ).toMatchObject({ kind: 'applied' });
        expect(yield* isStored(fake.workspaceState, key)).toBe(false);

        // The settings view still cannot write a row it does not render.
        expect(
          yield* applyStateSettingUpdate(key, 20000, {
            stores: fake.stores,
            host: 'vscode',
          }),
        ).toEqual({ kind: 'ignored' });
      }),
  );

  it.effect(
    'ignores unknown keys and preserves catalog validation errors',
    () =>
      Effect.gen(function* () {
        const ports = {
          stores: makeFakeSettingsStores().stores,
          host: 'vscode' as const,
        };

        expect(
          yield* applyStateSettingUpdate('texra.unknown', true, ports),
        ).toEqual({ kind: 'ignored' });

        expect(
          yield* applyStateSettingUpdate(
            DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
            'bogus',
            ports,
          ),
        ).toMatchObject({
          kind: 'rejected',
          entry: {
            key: DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
            surfaces: { settingsView: 'latex' },
          },
          error: expect.any(Error),
        });
      }),
  );
});
