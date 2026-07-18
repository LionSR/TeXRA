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
import { useLitComponentTestDom } from './litComponentTestUtils';

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

type ModelsTabElement = LitTestElement & {
  reliabilitySettings: typeof reliabilitySettings;
};

async function mountModelsTab(): Promise<ModelsTabElement> {
  const tab = document.createElement('models-tab') as ModelsTabElement;
  tab.reliabilitySettings = reliabilitySettings;
  document.body.append(tab);
  await tab.updateComplete;
  return tab;
}

async function getReliabilitySection(
  tab: ModelsTabElement,
): Promise<LitTestElement | null> {
  const section = tab.shadowRoot?.querySelector(
    'reliability-settings-section',
  ) as LitTestElement | null;
  await section?.updateComplete;
  return section;
}

describe('settings reliability placement', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/tabs/ModelsTab');
    await import('@settingsView/frontend/tabs/MultiAgentTab');
  });

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('shows reliability settings at the bottom of the Models tab', async () => {
    const tab = await mountModelsTab();
    const section = await getReliabilitySection(tab);

    expect(section).not.toBeNull();
    expect(section?.shadowRoot?.textContent).toContain('Reliability');
    expect(section?.shadowRoot?.textContent).toContain('Retry attempts');
  });

  it('does not render model reliability controls in Multi-Agent', async () => {
    const tab = document.createElement('multi-agent-tab') as LitTestElement;
    document.body.append(tab);

    await tab.updateComplete;

    expect(tab.shadowRoot?.textContent).not.toContain('Compaction threshold');
    expect(tab.shadowRoot?.textContent).not.toContain('Retry attempts');
  });

  it('posts numeric reliability changes through the existing VS Code setting command', async () => {
    const tab = await mountModelsTab();

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
        SETTINGS_VIEW_COMMANDS.SET_PROVIDER_VSCODE_SETTING,
        {
          key: 'texra.model.compactionThresholdPercent',
          value: 100,
        },
      ],
    ]);
  });
});
