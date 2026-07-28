// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test DOM
import { useLitComponentTestDom } from './litComponentTestUtils';

type AccountTabElement = HTMLElement & {
  authenticated: boolean;
  sessionProblem: 'expired' | 'unavailable' | null;
  userEmail: string;
  spendingStatusError: {
    spendCheckFailed: boolean;
    failureReason: string | null;
    limit: number | null;
  } | null;
  updateComplete: Promise<boolean>;
};

async function loadAccountTab(): Promise<void> {
  await import('@settingsView/frontend/tabs/AccountTab');
}

async function mountAccountTab(): Promise<AccountTabElement> {
  const element = document.createElement('account-tab') as AccountTabElement;
  element.authenticated = true;
  document.body.append(element);
  await element.updateComplete;
  return element;
}

describe('account usage status', () => {
  useLitComponentTestDom(loadAccountTab);

  it('limits spend-check failures to usage data', async () => {
    const element = await mountAccountTab();
    element.spendingStatusError = {
      spendCheckFailed: true,
      failureReason: 'usage query unavailable',
      limit: 300,
    };
    await element.updateComplete;

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('Usage data is temporarily unavailable');
    expect(text).toContain('Included model access may still work');
    expect(text).not.toContain('switch to your own provider API keys');
    expect(text).not.toContain('Usage data is not available for this account.');
  });

  it('gives an expired session precedence over a spend-check failure', async () => {
    const element = await mountAccountTab();
    element.authenticated = false;
    element.sessionProblem = 'expired';
    element.spendingStatusError = {
      spendCheckFailed: true,
      failureReason: 'stale server error',
      limit: null,
    };
    await element.updateComplete;

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain(
      "Usage data can't load because your session has expired.",
    );
    expect(text).not.toContain('Usage check failed on the server');
  });

  it('does not call a transient refresh failure an expired session', async () => {
    const element = await mountAccountTab();
    element.authenticated = true;
    element.sessionProblem = 'unavailable';
    element.userEmail = 'researcher@example.com';
    await element.updateComplete;

    const text = element.shadowRoot?.textContent ?? '';
    expect(text).toContain('authentication service is temporarily unavailable');
    expect(text).toContain('researcher@example.com');
    expect(text).not.toContain('session has expired');
    expect(text).not.toContain('Connected');
    expect(element.shadowRoot?.textContent).not.toContain('Sign in');
  });
});
