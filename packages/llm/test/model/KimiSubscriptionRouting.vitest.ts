import { describe, expect, it } from 'vitest';

import {
  decideModelRoute,
  type ModelConfig,
  ModelProvider,
  OWN_KEY_ROUTE_FACTS,
} from '@texra-ai/llm';

const dual = {
  provider: ModelProvider.MOONSHOT,
  kimiSubscription: true,
  id: 'kimi-k3',
} as const;

const asConfig = (fields: object) =>
  // cast: a route reads only the provider, id and subscription fields a case names.
  ({ openRouterOnly: false, capabilities: {}, ...fields }) as ModelConfig;

/** `planOn`: the "Kimi Code subscription" switch is on and a key is stored. */
const kimiRoute = (fields: object, planOn: boolean) =>
  decideModelRoute(asConfig(fields), {
    ...OWN_KEY_ROUTE_FACTS,
    plans: planOn ? ['kimi-code-subscription'] : [],
  });

const onKimiCode = {
  kind: 'api-key',
  endpoint: 'https://api.kimi.com/coding/v1',
  provider: 'kimiCode',
  plan: 'kimi-code-subscription',
};

describe('decideModelRoute on Kimi Code', () => {
  it('routes dual-backend only with the plan on', () => {
    expect(kimiRoute(dual, true)).toEqual(onKimiCode);
    // Plan off (switch off, or no key) → open platform.
    expect(kimiRoute(dual, false)).not.toEqual(onKimiCode);
  });
});
