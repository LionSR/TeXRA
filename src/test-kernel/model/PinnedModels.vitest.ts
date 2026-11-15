// Third-party imports
import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';

// Local imports
import {
  decideModelRoute,
  modelConfig,
  OWN_KEY_ROUTE_FACTS,
} from '@texra-ai/llm';
import { Settings } from '@texra-ai/harness/plugins';
import { HELPER_MODEL_SETTING } from '@texra-ai/harness/schemas';
import { CURATED_MODELS } from '@texra/model/curatedModels';
import {
  CLAUDE_AGENT_MODEL_VALUES,
  CODEX_MODEL_VALUES,
} from '@texra/shared/agentCliSettings';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@texra/model/setupModelDefaults';

/**
 * Every model id TeXRA ships as literal data. An llm-zoo bump that retires or
 * deprecates one fails here, and the pin is replaced by hand: nothing probes
 * a dead model or swaps one silently at runtime. The agent CLI defaults are
 * decoded through their settings' schemas, which also fails a default the
 * picker no longer offers.
 */
const PINNED: readonly (readonly [string, string])[] = [
  [
    'helper model setting',
    Settings.defaultOf(TEXRA_SETTINGS.catalog, HELPER_MODEL_SETTING) ?? '',
  ],
  ...CURATED_MODELS.map((model) => ['CURATED_MODELS', model] as const),
  ...Object.entries(SETUP_MODEL_BY_PROVIDER).map(
    ([provider, model]) => [`setup model for ${provider}`, model] as const,
  ),
  [
    'Claude Code model setting',
    Schema.decodeUnknownSync(CLAUDE_AGENT_MODEL_VALUES.schema)(undefined),
  ],
  [
    'Codex model setting',
    Schema.decodeUnknownSync(CODEX_MODEL_VALUES.schema)(undefined),
  ],
];

describe('pinned model ids', () => {
  it.each(PINNED)('%s: %s is live and directly reachable', (_, model) => {
    const config = modelConfig(model);
    expect(config, `unknown model "${model}"`).toBeDefined();
    expect(config?.retired ?? false).toBe(false);
    expect(config?.deprecated ?? false).toBe(false);
    expect(config?.openRouterOnly ?? false).toBe(false);
  });

  // CHATGPT_SETUP_MODEL proves ChatGPT subscription access, which only a
  // Codex-eligible model id can.
  it('the ChatGPT setup model routes to the subscription', () => {
    const config = modelConfig(CHATGPT_SETUP_MODEL);
    expect(config).toBeDefined();
    if (config === undefined) return;
    expect(
      decideModelRoute(config, {
        ...OWN_KEY_ROUTE_FACTS,
        plans: ['chatgpt-subscription'],
      }),
    ).toMatchObject({ kind: 'session', plan: 'chatgpt-subscription' });
  });
});
