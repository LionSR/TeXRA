import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/hostBridge', () => ({
  postMessage: vi.fn(),
  hostBridge: {
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  },
}));

import type { SettingsNavEntry } from '@settingsView/frontend/settingsNav';
import type { SettingsTabPanelName } from '@shared/settingsView/settingsViewMessages';

import { useLitComponentTestDom } from './litComponentTestUtils';

type LitElementLike = HTMLElement & { updateComplete: Promise<unknown> };

let navEntries: readonly SettingsNavEntry[] = [];
let settingsState: typeof import('@settingsView/frontend/settingsState');

function setSelectedPanel(panel: SettingsTabPanelName): void {
  settingsState.selectedPanel.set(panel);
}

function getSelectedPanel(): SettingsTabPanelName {
  return settingsState.selectedPanel.get();
}

async function mountSettingsApp(
  initialTab: SettingsTabPanelName = 'models',
): Promise<LitElementLike> {
  const app = document.createElement('settings-app') as LitElementLike;
  app.setAttribute('data-desktop-view', 'settings');
  setSelectedPanel(initialTab);
  document.body.append(app);
  await app.updateComplete;
  return app;
}

function pageButton(app: LitElementLike, panel: string): HTMLElement {
  const button = app.shadowRoot?.querySelector<HTMLElement>(
    `.settings-page-button[data-panel="${panel}"]`,
  );
  expect(button, `missing settings page "${panel}"`).not.toBeNull();
  return button!;
}

function activePanelLabel(app: LitElementLike): string | null | undefined {
  return app.shadowRoot
    ?.querySelector('.settings-panel')
    ?.getAttribute('aria-label');
}

describe('flat settings navigation', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/SettingsApp');
    const nav = await import('@settingsView/frontend/settingsNav');
    settingsState = await import('@settingsView/frontend/settingsState');
    navEntries = nav.SETTINGS_NAV_ENTRIES;
  });

  beforeEach(() => {
    setSelectedPanel('models');
  });

  it('shows every page in one strip and switches to any of them', async () => {
    const app = await mountSettingsApp();

    expect(
      app.shadowRoot?.querySelectorAll('.settings-page-button'),
    ).toHaveLength(navEntries.length);
    for (const entry of navEntries) {
      pageButton(app, entry.panel).click();
      await app.updateComplete;
      expect(getSelectedPanel()).toBe(entry.panel);
      expect(activePanelLabel(app)).toBe(entry.label);
    }
  });

  it('activates the page addressed by a wire panel name', async () => {
    const app = await mountSettingsApp('latex');

    expect(activePanelLabel(app)).toBe('LaTeX');
    expect(
      app.shadowRoot?.querySelector(
        '.settings-page-button[data-panel="latex"][data-active="true"]',
      ),
    ).not.toBeNull();
    expect(app.shadowRoot?.querySelector('latex-tab')).not.toBeNull();
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
