// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - shared schemas
import type { ModelSelectionItem } from '@shared/schemas/settingsViewMessages';

// Local imports - test utilities
import { useLitComponentTestDom } from './litComponentTestUtils';

type ModelsTabElement = HTMLElement & {
  modelSelectionItems: ModelSelectionItem[];
  updateComplete: Promise<boolean>;
};

const copilotModel: ModelSelectionItem = {
  name: 'copilot:sonnet46',
  label: 'Copilot · Claude Sonnet 4.6',
  provider: 'copilot',
  enabled: false,
  deprecated: false,
  supportsReasoningLevel: false,
  availability: 'copilot-consent-required',
  availabilityLabel: 'Copilot consent required',
  disabled: true,
  requiresKey: false,
};

describe('Copilot model access settings', () => {
  useLitComponentTestDom(() => import('@settingsView/frontend/tabs/ModelsTab'));

  it('shows a keyless consent action only when VS Code discovers Copilot models', async () => {
    const tab = document.createElement('models-tab') as ModelsTabElement;
    tab.modelSelectionItems = [copilotModel];
    document.body.append(tab);
    await tab.updateComplete;

    const section = tab.shadowRoot?.querySelector('#copilot-access');
    expect(section?.textContent).toContain('Copilot in VS Code');
    expect(section?.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      'No provider API key is needed',
    );

    let requestedModel: string | undefined;
    tab.addEventListener('model-access-request', (event) => {
      requestedModel = (event as CustomEvent<{ modelName: string }>).detail
        .modelName;
    });

    section?.querySelector<HTMLElement>('wa-button')?.click();
    expect(requestedModel).toBe('copilot:sonnet46');
  });

  it('omits the Copilot section when the host discovers no models', async () => {
    const tab = document.createElement('models-tab') as ModelsTabElement;
    tab.modelSelectionItems = [];
    document.body.append(tab);
    await tab.updateComplete;

    expect(tab.shadowRoot?.querySelector('#copilot-access')).toBeNull();
  });
});
