import { describe, expect, it } from 'vitest';
import { ModelProvider } from 'llm-zoo';

import { decideModelRoute, OWN_KEY_ROUTE_FACTS } from '@texra-ai/llm';
import type { ModelConfig } from 'llm-zoo';

const dual = {
  provider: ModelProvider.MOONSHOT,
  kimiSubscription: true,
  id: 'kimi-k3',
} as const;

const asConfig = (fields: object) =>
  ({ openRouterOnly: false, capabilities: {}, ...fields }) as ModelConfig;

const kimiRoute = (
  fields: object,
  kimiCodeKey: boolean,
  preferKimiCode: boolean,
) =>
  decideModelRoute(asConfig(fields), {
    ...OWN_KEY_ROUTE_FACTS,
    kimiCodeKey,
    preferKimiCode,
  });

const onKimiCode = {
  kind: 'api-key',
  provider: 'kimiCode',
  usageRoute: 'kimi-code-subscription',
};

describe('decideModelRoute on Kimi Code', () => {
  it('routes dual-backend only with prefer on and a key set', () => {
    expect(kimiRoute(dual, true, true)).toEqual(onKimiCode);
    // prefer off → open platform.
    expect(kimiRoute(dual, true, false)).not.toEqual(onKimiCode);
    // no key → open platform.
    expect(kimiRoute(dual, false, true)).not.toEqual(onKimiCode);
  });
});
