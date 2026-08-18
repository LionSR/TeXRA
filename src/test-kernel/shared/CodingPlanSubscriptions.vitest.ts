import { describe, expect, it } from 'vitest';

import {
  CODING_PLAN_SUBSCRIPTIONS,
  codingPlanForApiProvider,
  codingPlanForUsageRoute,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import {
  QUOTA_FALLBACK_ROUTES,
  quotaFallbackRouteForExhaustion,
} from '@shared/quotaFallbackRoutes';
import { SUBSCRIPTION_USAGE_PROVIDERS } from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';

describe('coding-plan subscription catalog', () => {
  it('is deeply immutable', () => {
    expect(Object.isFrozen(CODING_PLAN_SUBSCRIPTIONS)).toBe(true);
    for (const plan of CODING_PLAN_SUBSCRIPTIONS) {
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.cliAliases)).toBe(true);
      expect(Object.isFrozen(plan.usageVariantSettingKeys)).toBe(true);
    }
  });

  it('keeps every provider identity unique and visible to usage hosts', () => {
    const unique = <T>(values: readonly T[]): number => new Set(values).size;

    expect(unique(CODING_PLAN_SUBSCRIPTIONS.map((plan) => plan.id))).toBe(
      CODING_PLAN_SUBSCRIPTIONS.length,
    );
    expect(
      unique(CODING_PLAN_SUBSCRIPTIONS.map((plan) => plan.usageRoute)),
    ).toBe(CODING_PLAN_SUBSCRIPTIONS.length);
    expect(SUBSCRIPTION_USAGE_PROVIDERS).toEqual([
      'chatgpt',
      ...CODING_PLAN_SUBSCRIPTIONS.map((plan) => plan.usageProvider),
    ]);
  });

  it('resolves route, credential, and usage-setting identities', () => {
    expect(codingPlanForUsageRoute('glm-coding-plan-subscription')?.id).toBe(
      'glmCodingPlan',
    );
    expect(codingPlanForApiProvider('glm')?.usageProvider).toBe(
      'glmCodingPlan',
    );
    expect(codingPlanForUsageSetting(GlobalStateKey.GLM_USE_CHINA)?.id).toBe(
      'glmCodingPlan',
    );
  });
});

describe('quota-fallback route catalog', () => {
  it('covers ChatGPT, Grok, and every coding plan exactly once', () => {
    expect(QUOTA_FALLBACK_ROUTES.map((route) => route.id)).toEqual([
      'chatgpt',
      'grok',
      ...CODING_PLAN_SUBSCRIPTIONS.map((plan) => plan.id),
    ]);
    expect(quotaFallbackRouteForExhaustion('xai-subscription')?.id).toBe(
      'grok',
    );
    expect(quotaFallbackRouteForExhaustion('chatgpt-subscription')?.id).toBe(
      'chatgpt',
    );
  });
});
