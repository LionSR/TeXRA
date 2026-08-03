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
import type { CopilotRouteInfo } from '@shared/schemas/settingsViewMessages';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type ModelsTabElement = HTMLElement & {
  copilotModels: CopilotRouteInfo[];
  updateComplete: Promise<boolean>;
};

// Copilot routes are keyed by the canonical base model id (#9635); the
// section renders route status, never picker rows of its own.
const consentRoute: CopilotRouteInfo = {
  name: 'sonnet46',
  label: 'Claude Sonnet 4.6',
  access: 'consent-required',
};

function renderModelsTab(
  copilotModels: CopilotRouteInfo[],
): Promise<ModelsTabElement> {
  return mountComponent<ModelsTabElement>('models-tab', {
    copilotModels,
  });
}

describe('Copilot model access settings', () => {
  useLitComponentTestDom(() => import('@settingsView/frontend/tabs/ModelsTab'));

  beforeEach(() => {
    mocks.postMessage.mockClear();
  });

  it('shows a keyless consent action only when VS Code discovers Copilot models', async () => {
    const tab = await renderModelsTab([consentRoute]);

    const section = tab.shadowRoot?.querySelector('#copilot-access');
    expect(section?.textContent).toContain('Copilot in VS Code');
    expect(section?.textContent?.replaceAll(/\s+/g, ' ')).toContain(
      'No provider API key is needed',
    );

    section?.querySelector<HTMLElement>('wa-button')?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, { modelName: 'sonnet46' }],
    ]);
  });

  it('omits the Copilot section when the host discovers no models', async () => {
    const tab = await renderModelsTab([]);

    expect(tab.shadowRoot?.querySelector('#copilot-access')).toBeNull();
  });
});
