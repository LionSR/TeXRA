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

type RadioGroup = HTMLElement & { value: string };

function radioGroup(section: ApiAccessElement): RadioGroup | null {
  return section.shadowRoot?.querySelector<HTMLElement>(
    'wa-radio-group',
  ) as RadioGroup | null;
}

function selectMode(group: RadioGroup, value: string): void {
  group.value = value;
  group.dispatchEvent(new Event('change'));
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

    const group = radioGroup(section);
    if (!group) return;
    selectMode(group, 'included');
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(group.value).toBe('personal');

    section.includedAccessExhausted = false;
    await section.updateComplete;
    expect(
      section.shadowRoot
        ?.querySelector('wa-radio[value="included"]')
        ?.hasAttribute('disabled'),
    ).toBe(false);
    selectMode(group, 'included');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      { mode: 'included' },
    );
    expect(group.value).toBe('personal');
  });

  it('keeps the authoritative mode selected while the host rejects a change', async () => {
    const section = await mountComponent<ApiAccessElement>(
      'api-access-section',
      { mode: 'personal', includedAccessExhausted: false },
    );
    const group = radioGroup(section);
    expect(group).not.toBeNull();
    if (!group) return;

    selectMode(group, 'included');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE,
      { mode: 'included' },
    );
    expect(group.value).toBe('personal');
  });
});
