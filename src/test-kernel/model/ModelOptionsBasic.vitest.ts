// Third-party imports
import { describe, expect, it } from 'vitest';

import { modelConfig } from '@texra-ai/llm';
import { Settings } from '@texra-ai/harness/plugins';
import { DEFAULT_MODELS } from '@shared/constants/defaultModels';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { HELPER_MODEL_SETTING } from '@texra-ai/harness/schemas';

// Local imports - model

describe("TeXRA's default helper model", () => {
  it('resolves to a valid, non-deprecated DeepSeek model in llm-zoo', () => {
    const config = modelConfig(
      Settings.defaultOf(TEXRA_SETTINGS.catalog, HELPER_MODEL_SETTING) ?? '',
    );

    expect(config).toBeDefined();
    expect(config?.provider).toBe('deepseek');
    expect(config?.deprecated ?? false).toBe(false);
  });
});

describe('default model list', () => {
  // The list is literal data: an llm-zoo bump that retires or deprecates an
  // entry fails here and the entry is replaced by hand.
  it('only contains live, non-deprecated models', () => {
    expect(
      DEFAULT_MODELS.filter(
        (model) =>
          modelConfig(model)?.retired || modelConfig(model)?.deprecated,
      ),
    ).toEqual([]);
  });
});
