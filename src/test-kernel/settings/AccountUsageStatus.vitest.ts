// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test DOM
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

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

function mountAccountTab(): Promise<AccountTabElement> {
  return mountComponent<AccountTabElement>('account-tab', {
    authenticated: true,
  });
}

function shadowText(element: AccountTabElement): string {
  return element.shadowRoot?.textContent ?? '';
}

describe('account usage status', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/tabs/AccountTab'),
  );

  it('explains that spend-check failures disable included access', async () => {
    const element = await mountAccountTab();
    element.spendingStatusError = {
      spendCheckFailed: true,
      failureReason: 'usage query unavailable',
      limit: 300,
    };
    await element.updateComplete;

    const text = shadowText(element);
    expect(text).toContain('TeXRA could not check your usage right now');
    expect(text).toContain('Included access is temporarily');
    expect(text).toContain('Switch to your own API keys');
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

    const text = shadowText(element);
    expect(text).toContain(
      "Usage data can't load because your session has expired.",
    );
    expect(text).not.toContain('TeXRA could not check your usage right now');
  });

  it('does not call a transient refresh failure an expired session', async () => {
    const element = await mountAccountTab();
    element.sessionProblem = 'unavailable';
    element.userEmail = 'researcher@example.com';
    await element.updateComplete;

    const text = shadowText(element);
    expect(text).toContain('authentication service is temporarily unavailable');
    expect(text).toContain('researcher@example.com');
    expect(text).not.toContain('session has expired');
    expect(text).not.toContain('Connected');
    expect(text).not.toContain('Sign in');
  });
});
