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
  it('shows subscription-backed usage as Free · ChatGPT', async () => {
    const element = await mountUsagePanel(
      usage({ cost: 0, usageRoute: 'chatgpt-subscription' }),
    );

    expect(panelText(element)).toContain('Free · ChatGPT');
    expect(usageAriaLabel(element)).toContain('Free via ChatGPT');
  });

  it('shows Kimi Code subscription usage as free', async () => {
    const element = await mountUsagePanel(
      usage({
        cost: 0,
        usageRoute: 'kimi-code-subscription',
      }),
    );

    expect(panelText(element)).toContain('Free · Kimi Code');
    expect(usageAriaLabel(element)).toContain('Free via Kimi Code');
  });

  it.each([
    {
      route: 'relay' as UsageRoute,
      visibleLabel: 'Included',
      detailedLabel: 'included access',
    },
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

  it('keeps the route badge intact while the summary can shrink', async () => {
    const element = await mountUsagePanel(usage({ usageRoute: 'api-key' }));
    const styles = (element.constructor as typeof UsagePanel).elementStyles
      .flatMap((style) =>
        'cssText' in style
          ? style.cssText
          : [...style.cssRules].map((rule) => rule.cssText),
      )
      .join('\n');

    expect(styles).toMatch(
      /\.run-summary__route\s*{[^}]*white-space:\s*nowrap/s,
    );
    expect(styles).toMatch(/\.run-summary\s*{[^}]*min-width:\s*0/s);
    expect(styles).toMatch(/\.run-summary__value\s*{[^}]*min-width:\s*0/s);
  });
});
