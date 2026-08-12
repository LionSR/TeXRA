// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports - component and schema types
import type { ReliabilitySettingsSection } from '@settingsView/frontend/components/profile/ReliabilitySettingsSection';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

describe('reliability-settings-section', () => {
  useLitComponentTestDom(
    () =>
      import('@settingsView/frontend/components/profile/ReliabilitySettingsSection'),
  );

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('normalizes fractional retry values to the configured integer step', async () => {
    const section = await mountComponent<ReliabilitySettingsSection>(
      'reliability-settings-section',
      {
        settings: [
          {
            key: 'texra.model.retry.maxAttempts',
            label: 'Automatic retries',
            description: 'Additional retries after the initial request.',
            value: 2,
            min: 0,
            max: 5,
            step: 1,
          },
        ],
      },
    );
    const input = section.shadowRoot?.querySelector('wa-input') as
      (HTMLElement & { value: string }) | null;
    if (!input) throw new Error('wa-input not rendered');

    input.value = '2.5';
    input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    expect(input.value).toBe('3');
    expect(mocks.postMessage).toHaveBeenCalledWith(
      SETTINGS_VIEW_COMMANDS.SET_PROVIDER_SETTING,
      {
        key: 'texra.model.retry.maxAttempts',
        value: 3,
      },
    );
  });
});
