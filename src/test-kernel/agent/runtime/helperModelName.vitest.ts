import { describe, expect, it } from 'vitest';

import { getHelperModelName } from '@agent/runtime/helperModelName';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';
import { installPlatform } from '@test/support/setupPlatform';

describe('resolveEffectiveHelperModel', () => {
  it('returns the configured model when it is in the candidate list', () => {
    expect(resolveEffectiveHelperModel('gpt55', ['gpt55', 'opus'])).toBe(
      'gpt55',
    );
  });

  it('falls back to the built-in default when the configured model is not in the list', () => {
    expect(
      resolveEffectiveHelperModel('retired-model', ['gpt55', 'opus']),
    ).toBe(DEFAULT_HELPER_MODEL);
  });

  it('falls back to the built-in default when the candidate list is empty', () => {
    expect(resolveEffectiveHelperModel('retired-model', [])).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });

  it('returns the built-in default as-is regardless of the candidate list', () => {
    expect(resolveEffectiveHelperModel(DEFAULT_HELPER_MODEL, [])).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });

  it('returns the built-in default when no model is configured', () => {
    expect(resolveEffectiveHelperModel(undefined, ['gpt55'])).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });
});

describe('getHelperModelName', () => {
  it('accepts a non-default configured model as-is when ENABLED_MODELS is unset', async () => {
    await installPlatform({
      globalState: {
        [GlobalStateKey.HELPER_MODEL]: 'legacy-helper-model',
        // ENABLED_MODELS intentionally left unset -- matches a user who has
        // never touched the Enabled Models checkboxes.
      },
    });

    expect(getHelperModelName()).toBe('legacy-helper-model');
  });

  it('falls back to the built-in default when the configured model is not enabled', async () => {
    await installPlatform({
      globalState: {
        [GlobalStateKey.HELPER_MODEL]: 'retired-model',
        [GlobalStateKey.ENABLED_MODELS]: ['gpt55', 'opus'],
      },
    });

    expect(getHelperModelName()).toBe(DEFAULT_HELPER_MODEL);
  });
});

describe('#7582 runtime vs Settings UI helper-model divergence', () => {
  it('preserves the deliberate empty-candidate-list divergence between getHelperModelName and the Settings UI', async () => {
    // Realistic trigger from the issue: an existing user with a validly
    // configured, non-default HELPER_MODEL who has never touched the Enabled
    // Models checkboxes (ENABLED_MODELS stays unset), where the configured
    // model isn't (or is no longer) one of DEFAULT_MODELS.
    const configuredModel = 'legacy-helper-model-not-in-defaults';
    expect(DEFAULT_MODELS).not.toContain(configuredModel);

    await installPlatform({
      globalState: {
        [GlobalStateKey.HELPER_MODEL]: configuredModel,
      },
    });

    // Runtime: an empty/unset ENABLED_MODELS means "no restriction" -- the
    // configured model is accepted as-is.
    expect(getHelperModelName()).toBe(configuredModel);

    // Settings UI: `getVisibleModels()` substitutes DEFAULT_MODELS when the
    // persisted enabled list is empty/unset, and `getEffectiveHelperModel`
    // requires membership in that substituted list -- so it falls back
    // instead of accepting the configured model as-is. This is a deliberate,
    // preserved difference (see helperModelName.ts), not a regression: both
    // call sites now share `resolveEffectiveHelperModel` for the "validate
    // against candidates, else fall back" logic, but each owns its own
    // candidate list and empty-list handling.
    const controller = new SettingsModelSelectionController({
      globalState: new FakeStateStore({
        [GlobalStateKey.HELPER_MODEL]: configuredModel,
      }),
      resolveModelOptions: async () => [],
    });

    const { helperModel } = await controller.buildSelectionData();
    expect(helperModel).not.toBe(configuredModel);
    expect(helperModel).toBe(DEFAULT_HELPER_MODEL);
  });
});
