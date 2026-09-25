import { Effect } from 'effect';
import { it } from '@effect/vitest';
// Suites for src/utils/config (platformSettings + providerConfig).

import { afterEach, describe, expect, vi } from 'vitest';
import { LATEX_CONFIG_DEFAULTS } from '@shared/constants/latexConfig';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { getProviderEndpoint } from '@utils/config/providerConfig';
import { readSettingFrom } from '@utils/config/platformSettings';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PlatformSettings
// ---------------------------------------------------------------------------

describe('readSettingFrom', () => {
  it.effect(
    'snaps a stored value that fails the schema back to the catalog default',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          installPlatform({
            workspaceState: {
              [WorkspaceStateKey.LATEX_FORMATTER]: 'not-a-formatter',
            },
          }),
        );
        expect(
          yield* readSettingFrom(
            testWorkspaceRoots(),
            WorkspaceStateKey.LATEX_FORMATTER,
          ),
        ).toBe(LATEX_CONFIG_DEFAULTS.latexFormatter);
      }),
  );
});

// ---------------------------------------------------------------------------
// ProviderConfig (#7873 — converge on readSettingFrom for catalog keys)
// ---------------------------------------------------------------------------

describe('getProviderEndpoint', () => {
  it.effect(
    'snaps an invalid stored value back to the catalog default instead of leaking it through',
    () =>
      Effect.gen(function* () {
        // Regression for #7873: the pre-fix local `read()` helper cast the raw
        // stored value to `string` without validating it, so a corrupted
        // non-string value flowed straight through. `readSettingFrom(testWorkspaceRoots(), )`
        // validates against the entry's schema first.
        yield* Effect.promise(() =>
          installPlatform({
            globalState: { [GlobalStateKey.ENDPOINT_OPENAI]: 42 },
          }),
        );
        expect(yield* getProviderEndpoint(testWorkspaceRoots(), 'openai')).toBe(
          '',
        );
      }),
  );
});
