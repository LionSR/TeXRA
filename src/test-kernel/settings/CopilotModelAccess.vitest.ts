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

async function renderModelsTab(
  modelSelectionItems: ModelSelectionItem[],
): Promise<ModelsTabElement> {
  const tab = document.createElement('models-tab') as ModelsTabElement;
  tab.modelSelectionItems = modelSelectionItems;
  document.body.append(tab);
  await tab.updateComplete;
  return tab;
}

describe('Copilot model access settings', () => {
  useLitComponentTestDom(() => import('@settingsView/frontend/tabs/ModelsTab'));

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('shows a keyless consent action only when VS Code discovers Copilot models', async () => {
    const tab = await renderModelsTab([copilotModel]);

    const section = tab.shadowRoot?.querySelector('#copilot-access');
    expect(section?.textContent).toContain('Copilot in VS Code');
    expect(section?.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      'No provider API key is needed',
    );

    section?.querySelector<HTMLElement>('wa-button')?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [
        SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS,
        { modelName: 'copilot:sonnet46' },
      ],
    ]);
  });

  it('omits the Copilot section when the host discovers no models', async () => {
    const tab = await renderModelsTab([]);

    expect(tab.shadowRoot?.querySelector('#copilot-access')).toBeNull();
  });
});
