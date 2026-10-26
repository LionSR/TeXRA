import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@texra/shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type { SubscriptionSectionProvider } from '@settingsView/frontend/components/profile/SubscriptionSection';
import type { SubscriptionAuthStatus } from '@texra/shared/model/subscriptionAuth';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type SubscriptionSectionElement = HTMLElement & {
  provider: SubscriptionSectionProvider;
  auth: SubscriptionAuthStatus | null;
  contextWindow: number;
  now: number;
  ackGeneration: number;
  updateComplete: Promise<boolean>;
};

let chatgptSection: SubscriptionSectionProvider;

describe('subscription-section budget input', () => {
  useLitComponentTestDom(async () => {
    const module =
      await import('@settingsView/frontend/components/profile/SubscriptionSection');
    chatgptSection = module.CHATGPT_SUBSCRIPTION_SECTION;
  });

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('keeps digits typed into the budget through a re-render until the host acknowledges', async () => {
    const element = await mountComponent<SubscriptionSectionElement>(
      'subscription-section',
      { provider: chatgptSection, auth: null, contextWindow: 128 },
    );
    const input = element.shadowRoot!.querySelector<
      HTMLElement & { value: string }
    >('.setting-number-input')!;
    expect(input.value).toBe('128');

    // Typed but not yet committed: the usage ticker's re-render keeps it.
    input.value = '25';
    element.now = 60_000;
    await element.updateComplete;
    expect(input.value).toBe('25');

    // The host's acknowledgement (a same-value rebroadcast) restores it.
    element.ackGeneration = 1;
    await element.updateComplete;
    expect(input.value).toBe('128');
  });
});
