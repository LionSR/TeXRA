// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - progress view component types
import type { UsagePanel } from '@progressView/frontend/components/UsagePanel';
import {
  TokenUsageStatsSchema,
  type TokenUsageStats,
  type UsageRoute,
} from '@shared/schemas';

// Local imports - shared schemas

// Local imports - test utilities
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

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

async function mountUsagePanel(stats: TokenUsageStats): Promise<UsagePanel> {
  const element = document.createElement('usage-panel') as UsagePanel;
  element.usage = stats;
  document.body.append(element);
  await element.updateComplete;
  return element;
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
  it('shows subscription-backed usage as Free · ChatGPT', async () => {
    const legacyUsage = TokenUsageStatsSchema.parse({
      inputTokens: 1200,
      outputTokens: 80,
      cost: 0,
      viaChatGptSubscription: true,
    });
    const element = await mountUsagePanel(legacyUsage);

    expect(panelText(element)).toContain('Free · ChatGPT');
    expect(usageAriaLabel(element)).toContain('Free via ChatGPT');
  });

  it.each([
    {
      route: 'relay' as UsageRoute,
      visibleLabel: 'relay',
      ariaCost: '$0.123 via relay',
    },
    {
      route: 'api-key' as UsageRoute,
      visibleLabel: 'your key',
      ariaCost: '$0.123 via your key',
    },
  ])(
    'shows $visibleLabel beside the cost',
    async ({ route, visibleLabel, ariaCost }) => {
      const element = await mountUsagePanel(
        usage({
          usageRoute: route,
        }),
      );

      const text = panelText(element);
      expect(text).toContain('$0.123');
      expect(text).toContain(visibleLabel);
      expect(usageAriaLabel(element)).toContain(ariaCost);
    },
  );
});
