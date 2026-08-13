import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

import type {
  SubscriptionAuthStatus,
  SubscriptionSectionProvider,
} from '@settingsView/frontend/components/profile/SubscriptionSection';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type SubscriptionSectionElement = HTMLElement & {
  provider: SubscriptionSectionProvider;
  auth: SubscriptionAuthStatus | null;
  updateComplete: Promise<boolean>;
};

let chatgptSection: SubscriptionSectionProvider;
let grokSection: SubscriptionSectionProvider;

function mount(
  provider: SubscriptionSectionProvider,
  auth: SubscriptionAuthStatus | null,
): Promise<SubscriptionSectionElement> {
  return mountComponent<SubscriptionSectionElement>('subscription-section', {
    provider,
    auth,
  });
}

function section(element: SubscriptionSectionElement, id: string): HTMLElement {
  const found = element.shadowRoot?.querySelector<HTMLElement>(`#${id}`);
  expect(found, `missing <section id="${id}">`).toBeInstanceOf(HTMLElement);
  return found!;
}

/**
 * One component renders both subscription providers, so the descriptor is the
 * only thing keeping ChatGPT's commands off the Grok section and vice versa.
 * These cases pin that wiring per provider.
 */
describe('subscription-section provider descriptors', () => {
  useLitComponentTestDom(async () => {
    const module =
      await import('@settingsView/frontend/components/profile/SubscriptionSection');
    chatgptSection = module.CHATGPT_SUBSCRIPTION_SECTION;
    grokSection = module.GROK_SUBSCRIPTION_SECTION;
  });

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('renders the ChatGPT section and posts its sign-in command', async () => {
    const element = await mount(chatgptSection, null);
    const chatgpt = section(element, 'chatgpt-subscription');

    expect(chatgpt.textContent).toContain('ChatGPT subscription');
    expect(chatgpt.textContent).toContain('ChatGPT account');

    chatgpt.querySelector<HTMLElement>('wa-button')?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT],
    ]);
  });

  it('renders the Grok section and posts its sign-out command when signed in', async () => {
    const element = await mount(grokSection, {
      signedIn: true,
      email: 'someone@example.com',
      preferSubscription: true,
    });
    const grok = section(element, 'grok-subscription');

    expect(grok.textContent).toContain('Grok subscription');
    expect(grok.textContent).toContain('Signed in as someone@example.com');

    grok.querySelector<HTMLElement>('wa-button')?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.SIGN_OUT_GROK],
    ]);
  });

  it('writes the preference through the provider-specific command', async () => {
    const element = await mount(chatgptSection, null);
    const preferSwitch = element.shadowRoot?.querySelector<
      HTMLElement & { checked?: boolean }
    >('wa-switch');

    expect(preferSwitch).toBeInstanceOf(HTMLElement);
    preferSwitch!.checked = true;
    preferSwitch!.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION,
      { enabled: true },
    );
  });
});
