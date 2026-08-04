// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports - shared schemas
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

const reliabilitySettings = [
  {
    key: 'texra.model.compactionThresholdPercent',
    label: 'Compaction threshold',
    description: 'Context window percentage to trigger compaction.',
    value: 75,
    min: 0,
    max: 100,
    unit: '%',
  },
  {
    key: 'texra.model.retry.maxAttempts',
    label: 'Retry attempts',
    description: 'Automatic retry attempts before manual retry.',
    value: 0,
    min: 0,
  },
];

type LitTestElement = HTMLElement & {
  updateComplete: Promise<unknown>;
};

type AgentsTabElement = LitTestElement & {
  reliabilitySettings: typeof reliabilitySettings;
};

function mountAgentsTab(): Promise<AgentsTabElement> {
  return mountComponent<AgentsTabElement>('agents-tab', {
    reliabilitySettings,
  });
}

async function getReliabilitySection(
  tab: AgentsTabElement,
): Promise<LitTestElement | null> {
  const section = tab.shadowRoot?.querySelector(
    'reliability-settings-section',
  ) as LitTestElement | null;
  await section?.updateComplete;
  return section;
}

describe('settings reliability placement', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/tabs/AgentsTab');
    await import('@settingsView/frontend/tabs/ModelsTab');
  });

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('shows reliability settings at the bottom of the Agents tab', async () => {
    const tab = await mountAgentsTab();
    const section = await getReliabilitySection(tab);

    expect(section).not.toBeNull();
    expect(section?.shadowRoot?.textContent).toContain('Reliability');
    expect(section?.shadowRoot?.textContent).toContain('Retry attempts');
  });

  it('does not render model reliability controls in Models', async () => {
    const tab = await mountComponent<LitTestElement>('models-tab');

    expect(tab.shadowRoot?.textContent).not.toContain('Compaction threshold');
    expect(tab.shadowRoot?.textContent).not.toContain('Retry attempts');
  });

  it('posts numeric reliability changes through the provider setting command', async () => {
    const tab = await mountAgentsTab();

    const section = await getReliabilitySection(tab);

    const input = section?.shadowRoot?.querySelector('wa-input') as
      (HTMLElement & { value: string }) | null;
    expect(input).not.toBeNull();
    input!.value = '101';
    input!.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.SET_PROVIDER_SETTING,
        {
          key: 'texra.model.compactionThresholdPercent',
          value: 100,
        },
      ],
    ]);
  });
});
