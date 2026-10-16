import { Effect } from 'effect';
import { it } from '@effect/vitest';
// Suites for the catalog reader (packages/harness/src/shared/config/settings.ts).

import { afterEach, describe, expect, vi } from 'vitest';
import { Settings } from '@shared/config/settings';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { TexraStateKey } from '@texra/shared/settingsView/texraSettings';
import { LATEX_CONFIG_DEFAULTS } from '@texra/shared/constants/latexConfig';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('Settings.get', () => {
  it.effect(
    'snaps a stored value that fails the schema back to the catalog default',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            workspaceState: {
              [TexraStateKey.LATEX_FORMATTER]: 'not-a-formatter',
            },
          }),
        );
        expect(
          yield* Settings.get(
            testWorkspaceRoots(),
            TexraStateKey.LATEX_FORMATTER,
          ),
        ).toBe(LATEX_CONFIG_DEFAULTS.latexFormatter);
      }),
  );
});
