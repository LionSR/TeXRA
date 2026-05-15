// Third-party imports
import { describe, expect, it } from 'vitest';

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

describe('settings reliability placement', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/tabs/ModelsTab');
    await import('@settingsView/frontend/tabs/MultiAgentTab');
  });

  it('shows reliability settings at the bottom of the Models tab', async () => {
    const tab = document.createElement('models-tab') as ModelsTabElement;
    tab.reliabilitySettings = reliabilitySettings;
    document.body.append(tab);

    await tab.updateComplete;
    const section = tab.shadowRoot?.querySelector(
      'reliability-settings-section',
    ) as LitTestElement | null;

    expect(section).not.toBeNull();
    await section?.updateComplete;
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

  it('emits numeric reliability changes through the existing VS Code setting event', async () => {
    const tab = document.createElement('models-tab') as ModelsTabElement;
    tab.reliabilitySettings = reliabilitySettings;
    document.body.append(tab);
    await tab.updateComplete;

    const events: unknown[] = [];
    tab.addEventListener('provider-vscode-setting-set', (event) => {
      events.push((event as CustomEvent).detail);
    });

    const section = tab.shadowRoot?.querySelector(
      'reliability-settings-section',
    ) as LitTestElement | null;
    await section?.updateComplete;

    const input = section?.shadowRoot?.querySelector('wa-input') as
      | (HTMLElement & { value: string })
      | null;
    expect(input).not.toBeNull();
    input!.value = '101';
    input!.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    expect(events).toEqual([
      {
        key: 'texra.model.compactionThresholdPercent',
        value: 100,
      },
    ]);
  });
});
