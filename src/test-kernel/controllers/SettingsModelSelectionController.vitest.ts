import { describe, expect, it } from 'vitest';

import {
  SettingsModelSelectionController,
  type SettingsModelSelectionState,
} from '@controllers/settingsView/SettingsModelSelectionController';
import { MAX_TIER } from '@auth/sharedConfig';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

function createState(
  overrides: Partial<{
    enabledModels: string[];
    helperModel: string;
    reasoningLevelOverrides: Record<string, string>;
    preferShortModelNames: boolean;
  }> = {},
): SettingsModelSelectionState {
  const state = {
    enabledModels: overrides.enabledModels,
    helperModel: overrides.helperModel,
    reasoningLevelOverrides: overrides.reasoningLevelOverrides,
    preferShortModelNames: overrides.preferShortModelNames,
  };
  return {
    getEnabledModels: () => state.enabledModels,
    setEnabledModels: async (models) => {
      state.enabledModels = models;
    },
    getHelperModel: () => state.helperModel,
    setHelperModel: async (model) => {
      state.helperModel = model;
    },
    getReasoningLevelOverrides: () => state.reasoningLevelOverrides,
    setReasoningLevelOverrides: async (overrides) => {
      state.reasoningLevelOverrides = overrides;
    },
    getPreferShortModelNames: () => state.preferShortModelNames,
    setPreferShortModelNames: async (enabled) => {
      state.preferShortModelNames = enabled;
    },
  };
}

describe('SettingsModelSelectionController', () => {
  it('uses canonical tier constants for included-access reasoning caps', () => {
    const controller = new SettingsModelSelectionController({
      state: createState(),
      useIncludedAccess: () => true,
      getUserTier: () => MAX_TIER,
    });

    const gpt55 = controller
      .buildSelectionData()
      .models.find((model) => model.name === 'gpt55');

    expect(gpt55).toMatchObject({
      supportsReasoningLevel: true,
      includedAccessReasoningCap: 'high',
    });
  });

  it('moves a stale helper fallback when disabling the effective helper model', async () => {
    const state = createState({
      enabledModels: ['gpt55', 'sonnet46T'],
      helperModel: 'removed-model',
    });
    const controller = new SettingsModelSelectionController({ state });

    expect(controller.buildSelectionData().helperModel).toBe('gpt55');

    await controller.setModelEnabled({ modelName: 'gpt55', enabled: false });

    expect(state.getEnabledModels()).toEqual(['sonnet46T']);
    expect(state.getHelperModel()).toBe('sonnet46T');
  });

  it('falls back to default models when the persisted enabled list is empty', () => {
    const controller = new SettingsModelSelectionController({
      state: createState({ enabledModels: [] }),
    });

    const enabled = controller
      .buildSelectionData()
      .models.filter((model) => model.enabled);

    // An empty persisted list must not blank out the helper-model dropdown.
    expect(enabled.length).toBeGreaterThan(0);
  });

  it('uses the runtime helper default when no helper model is configured', () => {
    const controller = new SettingsModelSelectionController({
      state: createState({
        enabledModels: ['gpt55', 'sonnet46T'],
      }),
    });

    expect(controller.buildSelectionData().helperModel).toBe(
      DEFAULT_HELPER_MODEL,
    );
  });
});
