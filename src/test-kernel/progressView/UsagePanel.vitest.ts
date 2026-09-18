// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import type { UsagePanel } from '@progressView/frontend/components/UsagePanel';
import { type TokenUsageStats, type UsageRoute } from '@shared/schemas';

// Local file imports
import {
  mountComponent,
  useLitComponentTestDom,
} from '../settings/litComponentTestUtils';

useLitComponentTestDom(
  () => import('@progressView/frontend/components/UsagePanel'),
);

function usage(overrides: Partial<TokenUsageStats>): TokenUsageStats {
  return {
    inputTokens: 1200,
    outputTokens: 80,
    cost: 0.123,
    ...overrides,
  };
}

function mountUsagePanel(stats: TokenUsageStats): Promise<UsagePanel> {
  return mountComponent<UsagePanel>('usage-panel', { usage: stats });
}

function panelText(element: UsagePanel): string {
  return element.shadowRoot?.textContent?.replaceAll(/\s+/g, ' ').trim() ?? '';
}

function usageAriaLabel(element: UsagePanel): string {
  return (
    element.shadowRoot
      ?.querySelector('.run-summary')
      ?.getAttribute('aria-label') ?? ''
  );
}

describe('usage-panel route badges', () => {
  it('names the plan that covers subscription-backed usage', async () => {
    const element = await mountUsagePanel(
      usage({ cost: 0, usageRoute: 'chatgpt-subscription', usagePlan: 'pro' }),
    );

    expect(panelText(element)).toContain('ChatGPT Pro');
    expect(usageAriaLabel(element)).toContain('Included in ChatGPT Pro');
  });

  // A plan the token never named, or one this build has no copy for, must not
  // reach the screen as a raw wire word.
  it.each(['', 'enterprise_v2'])(
    'falls back to the bare subscription for plan %j',
    async (usagePlan) => {
      const element = await mountUsagePanel(
        usage({ cost: 0, usageRoute: 'chatgpt-subscription', usagePlan }),
      );

      expect(panelText(element)).toContain('ChatGPT');
      expect(usageAriaLabel(element)).toContain(
        'Included in ChatGPT subscription',
      );
    },
  );

  it.each([
    {
      route: 'api-key' as UsageRoute,
      visibleLabel: 'API keys',
      detailedLabel: 'your own API keys',
    },
  ])(
    'shows $visibleLabel beside the cost',
    async ({ route, visibleLabel, detailedLabel }) => {
      const element = await mountUsagePanel(
        usage({
          usageRoute: route,
        }),
      );

      const text = panelText(element);
      expect(text).toContain('$0.123');
      expect(text).toContain(visibleLabel);
      expect(text).not.toContain(detailedLabel);
      expect(usageAriaLabel(element)).toContain(`$0.123 via ${detailedLabel}`);
    },
  );
});
