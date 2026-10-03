import { strict as assert } from 'node:assert';
import { it } from '@effect/vitest';
import { describe } from 'vitest';

import {
  API_KEY_PROVIDER_IDS,
  decideModelRoute,
  modelConfig,
  OWN_KEY_ROUTE_FACTS,
} from '@texra-ai/llm';
import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';

/**
 * The setup pins are literal data. An llm-zoo bump that retires or deprecates
 * a pin fails here, and the pin is replaced by hand — the setup assistant
 * never probes a dead model and never swaps one silently at runtime.
 */
describe('SETUP_MODEL_BY_PROVIDER', () => {
  it('pins every provider to a live, non-deprecated, directly reachable model', () => {
    for (const [provider, model] of Object.entries(SETUP_MODEL_BY_PROVIDER)) {
      const config = modelConfig(model);
      assert.ok(config, `${provider} pins unknown model "${model}"`);
      assert.equal(
        config.retired ?? false,
        false,
        `${provider}: "${model}" is retired`,
      );
      assert.equal(
        config.deprecated ?? false,
        false,
        `${provider}: "${model}" is deprecated`,
      );
      assert.equal(
        config.openRouterOnly ?? false,
        false,
        `${provider}: "${model}" is OpenRouter-only`,
      );
    }
    // CHATGPT_SETUP_MODEL proves ChatGPT subscription access, which only a
    // Codex-eligible model id can.
    assert.equal(CHATGPT_SETUP_MODEL, SETUP_MODEL_BY_PROVIDER.openai);
    const chatgptSetup = modelConfig(CHATGPT_SETUP_MODEL);
    assert.ok(chatgptSetup);
    assert.equal(
      decideModelRoute(chatgptSetup, {
        ...OWN_KEY_ROUTE_FACTS,
        chatgptSubscription: true,
      }).kind,
      'chatgpt-subscription',
    );
  });

  it('covers every non-OpenRouter direct-key API provider', () => {
    for (const provider of API_KEY_PROVIDER_IDS) {
      if (provider === 'openRouter') continue;
      assert.ok(
        SETUP_MODEL_BY_PROVIDER[provider],
        `missing setup model for provider "${provider}"`,
      );
    }
  });
});
