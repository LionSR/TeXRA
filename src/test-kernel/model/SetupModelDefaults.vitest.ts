import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { isCodexSubscriptionEligible } from '@model/providerCapabilities';
import { API_PROVIDERS } from '@model/apiProviders';

/**
 * #7081: setup-probe models were 10 hardcoded per-provider literals — when
 * one retires (as `grok4` has, live in the registry today), the setup
 * assistant probes a dead model and a valid key's verification fails.
 * `SETUP_MODEL_BY_PROVIDER` validates every pick against the live registry
 * and swaps to a still-active model when needed; these tests guard that no
 * provider's resolved model is ever retired or OpenRouter-only, regardless
 * of what happens to the curated preference table over time.
 */
describe('SETUP_MODEL_BY_PROVIDER', () => {
  it('never resolves a provider to a retired or OpenRouter-only model', () => {
    for (const [provider, model] of Object.entries(SETUP_MODEL_BY_PROVIDER)) {
      const config = getRuntimeModelConfig(model) ?? MODEL_CONFIGS[model];
      assert.ok(config, `${provider} resolved to unknown model "${model}"`);
      assert.equal(
        config.retired ?? false,
        false,
        `${provider} resolved to retired model "${model}"`,
      );
      assert.equal(
        config.openRouterOnly ?? false,
        false,
        `${provider} resolved to an OpenRouter-only model "${model}"`,
      );
    }
  });

  it('covers every non-OpenRouter direct-key API provider', () => {
    for (const provider of API_PROVIDERS) {
      if (provider === 'openRouter') continue;
      assert.ok(
        SETUP_MODEL_BY_PROVIDER[provider],
        `missing setup model for provider "${provider}"`,
      );
    }
  });

  it('falls back off a retired preferred pick to a live model for the same provider (xai/grok4)', () => {
    // grok4 is retired in the live registry as of this fix — the concrete
    // failure mode #7081 reported, exercised against real data rather than
    // a mock.
    assert.equal(MODEL_CONFIGS.grok4?.retired, true);
    const resolved = SETUP_MODEL_BY_PROVIDER.xai;
    assert.ok(resolved, 'xai has a known preference, so this always resolves');
    assert.notEqual(resolved, 'grok4');
    assert.equal(MODEL_CONFIGS[resolved]?.retired ?? false, false);
    assert.equal(MODEL_CONFIGS[resolved]?.provider, 'xai');
  });

  it('prefers the live grok45 pin for xAI setup probes', () => {
    assert.equal(SETUP_MODEL_BY_PROVIDER.xai, 'grok45');
  });

  it('keeps the preferred pick when it is still live (anthropic/opus5T)', () => {
    assert.equal(MODEL_CONFIGS.opus5T?.retired ?? false, false);
    assert.equal(SETUP_MODEL_BY_PROVIDER.anthropic, 'opus5T');
  });

  it('keeps CHATGPT_SETUP_MODEL Codex-eligible', () => {
    assert.equal(CHATGPT_SETUP_MODEL, SETUP_MODEL_BY_PROVIDER.openai);
    const config = MODEL_CONFIGS[CHATGPT_SETUP_MODEL];
    assert.ok(config);
    // Mirrors isUsableSetupModel's production check exactly, so this can't
    // pass on a model id the real setup path would reject.
    assert.ok(isCodexSubscriptionEligible(config));
  });
});
