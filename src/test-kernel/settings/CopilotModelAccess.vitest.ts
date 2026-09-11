// Third-party imports
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({
  postMessage: mocks.postMessage,
}));

// Local imports - shared schemas
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { CopilotRouteInfo } from '@shared/schemas';

// Local imports - test utilities
import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type SubscriptionsTabElement = HTMLElement & {
  copilotModels: CopilotRouteInfo[];
  updateComplete: Promise<boolean>;
};

// Copilot routes are keyed by the canonical base model id (#9635); the
// section renders route status, never picker rows of its own.
const consentRoute: CopilotRouteInfo = {
  name: 'sonnet46',
  label: 'Claude Sonnet 4.6',
  access: 'consent-required',
  preferred: false,
};

const allowedRoute: CopilotRouteInfo = {
  name: 'gpt55',
  label: 'GPT-5.5',
  access: 'allowed',
  preferred: false,
};

async function renderSubscriptionsTab(
  copilotModels: CopilotRouteInfo[],
): Promise<SubscriptionsTabElement> {
  const tab = await mountComponent<SubscriptionsTabElement>(
    'subscriptions-tab',
    {
      copilotModels,
    },
  );
  mocks.postMessage.mockClear();
  return tab;
}

function copilotSection(
  tab: SubscriptionsTabElement,
): HTMLElement | null | undefined {
  return tab.shadowRoot?.querySelector<HTMLElement>('#copilot-access');
}

function sectionButtons(
  section: HTMLElement | null | undefined,
): HTMLElement[] {
  return [...(section?.querySelectorAll<HTMLElement>('wa-button') ?? [])];
}

describe('Copilot model access settings', () => {
  useLitComponentTestDom(
    () => import('@settingsView/frontend/tabs/SubscriptionsTab'),
  );

  it('shows a keyless consent action only when VS Code discovers Copilot models', async () => {
    const tab = await renderSubscriptionsTab([consentRoute]);

    const section = copilotSection(tab);
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
    const tab = await renderSubscriptionsTab([]);

    expect(copilotSection(tab)).toBeNull();
  });

  it('offers an explicit opt-in for an already-authorized route', async () => {
    const tab = await renderSubscriptionsTab([allowedRoute]);

    const section = copilotSection(tab);
    expect(section?.textContent).toContain('1 Copilot model is ready');
    const button = section?.querySelector<HTMLElement>('wa-button');
    expect(button?.textContent).toContain('Use Copilot');

    button?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, { modelName: 'gpt55' }],
    ]);
  });

  it('offers an undo once the route is preferred', async () => {
    const tab = await renderSubscriptionsTab([
      { ...allowedRoute, preferred: true },
    ]);

    const section = copilotSection(tab);
    expect(section?.textContent).toContain('Using Copilot for this model.');
    const button = section?.querySelector<HTMLElement>('wa-button');
    expect(button?.textContent).toContain('Stop using Copilot');

    button?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE, { modelName: 'gpt55' }],
    ]);
  });

  it('keeps an unavailable preferred route removable', async () => {
    const tab = await renderSubscriptionsTab([
      { ...allowedRoute, access: 'unavailable', preferred: true },
    ]);

    const section = copilotSection(tab);
    expect(section?.textContent).toContain(
      '1 selected Copilot model needs attention.',
    );
    expect(section?.querySelector('wa-button')?.textContent).toContain(
      'Stop using Copilot',
    );
  });
});
