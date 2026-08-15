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

  it('keeps other route actions reachable while one route is preferred', async () => {
    const tab = await renderSubscriptionsTab([
      { ...allowedRoute, preferred: true },
      consentRoute,
    ]);

    const buttons = sectionButtons(copilotSection(tab));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Stop using Copilot',
      'Grant access',
    ]);
    const actionRows = [
      ...(tab.shadowRoot?.querySelectorAll<HTMLElement>(
        '#copilot-access .copilot-route-action',
      ) ?? []),
    ];
    expect(actionRows).toHaveLength(2);
    expect(actionRows[0]?.textContent).toContain('GPT-5.5');
    expect(actionRows[1]?.textContent).toContain('Claude Sonnet 4.6');
    expect(buttons[0]?.classList.contains('btn-secondary')).toBe(true);
    expect(buttons[0]?.getAttribute('appearance')).toBe('outlined');
    expect(buttons[1]?.classList.contains('btn-primary')).toBe(true);
    expect(buttons[1]?.getAttribute('appearance')).toBe('filled');

    buttons[0]?.click();
    buttons[1]?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE, { modelName: 'gpt55' }],
      [SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, { modelName: 'sonnet46' }],
    ]);
  });

  it('describes a preferred route that is waiting for consent', async () => {
    const tab = await renderSubscriptionsTab([
      { ...consentRoute, preferred: true },
    ]);

    const section = copilotSection(tab);
    expect(section?.textContent).toContain(
      'Selected. Waiting for your approval in VS Code.',
    );
    const buttons = sectionButtons(section);
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Grant access',
      'Stop using Copilot',
    ]);
    expect(section?.querySelector('.copilot-route-controls')).not.toBeNull();
    buttons[0]?.click();
    buttons[1]?.click();
    expect(mocks.postMessage.mock.calls).toEqual([
      [SETTINGS_VIEW_COMMANDS.REQUEST_MODEL_ACCESS, { modelName: 'sonnet46' }],
      [SETTINGS_VIEW_COMMANDS.CLEAR_COPILOT_ROUTE, { modelName: 'sonnet46' }],
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
