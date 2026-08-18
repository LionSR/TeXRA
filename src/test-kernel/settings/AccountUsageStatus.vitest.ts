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
