import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/hostBridge', () => ({
  postMessage: vi.fn(),
  hostBridge: {
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  },
}));

import type { SettingsTabPanelName } from '@shared/settingsView/settingsViewMessages';

import { useLitComponentTestDom } from './litComponentTestUtils';

type LitElementLike = HTMLElement & { updateComplete: Promise<unknown> };

let settingsState: typeof import('@settingsView/frontend/settingsState');

function setSelectedPanel(panel: SettingsTabPanelName): void {
  settingsState.selectedPanel.set(panel);
}

function activePanelLabel(app: LitElementLike): string | null | undefined {
  return app.shadowRoot
    ?.querySelector('.settings-panel')
    ?.getAttribute('aria-label');
}

describe('flat settings navigation', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/SettingsApp');
    settingsState = await import('@settingsView/frontend/settingsState');
  });

  beforeEach(() => {
    setSelectedPanel('models');
  });

  it('keeps desktop-only shortcuts out of the extension navigation', async () => {
    const app = document.createElement('settings-app') as LitElementLike;
    setSelectedPanel('shortcuts');
    document.body.append(app);
    await app.updateComplete;

    expect(
      app.shadowRoot?.querySelector(
        '.settings-page-button[data-panel="shortcuts"]',
      ),
    ).toBeNull();
    expect(activePanelLabel(app)).toBe('Models');
    expect(app.shadowRoot?.querySelector('shortcuts-tab')).toBeNull();
  });
});
