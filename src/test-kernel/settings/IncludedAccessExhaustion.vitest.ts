import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postMessage: vi.fn() }));
vi.mock('@shared/hostBridge', () => ({ postMessage: mocks.postMessage }));

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

interface ApiAccessElement extends HTMLElement {
  mode: 'included' | 'personal';
  includedAccessExhausted: boolean;
  updateComplete: Promise<boolean>;
}

describe('included access exhaustion rendering', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/components/profile/ApiAccessSection'),
  );

  beforeEach(() => mocks.postMessage.mockClear());

  it('blocks the included choice while exhausted and re-enables it after refresh', async () => {
    const section = await mountComponent<ApiAccessElement>(
      'api-access-section',
      { mode: 'personal', includedAccessExhausted: true },
    );
    const included = section.shadowRoot?.querySelector<HTMLElement>(
      'wa-radio[value="included"]',
    );
    expect(included?.hasAttribute('disabled')).toBe(true);
    expect(included?.textContent).toContain(
      'Monthly included usage is exhausted',
    );

    const group = section.shadowRoot?.querySelector<HTMLElement>(
      'wa-radio-group',
    ) as (HTMLElement & { value: string }) | null;
    if (!group) return;
    group.value = 'included';
    group.dispatchEvent(new Event('change'));
    expect(mocks.postMessage).not.toHaveBeenCalled();

    section.includedAccessExhausted = false;
    await section.updateComplete;
    expect(
      section.shadowRoot
        ?.querySelector('wa-radio[value="included"]')
        ?.hasAttribute('disabled'),
    ).toBe(false);
    group.value = 'included';
    group.dispatchEvent(new Event('change'));
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      { mode: 'included' },
    );
  });
});
