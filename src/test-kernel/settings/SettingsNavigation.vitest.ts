import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/hostBridge', () => ({
  postMessage: vi.fn(),
  hostBridge: {
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  },
}));

import type { SettingsNavGroup } from '@settingsView/frontend/settingsNav';
import type {
  SettingsTabPanelName,
} from '@shared/settingsView/settingsViewMessages';

import { useLitComponentTestDom } from './litComponentTestUtils';

type LitElementLike = HTMLElement & { updateComplete: Promise<unknown> };

let navGroups: readonly SettingsNavGroup[] = [];
let settingsState: typeof import('@settingsView/frontend/settingsState');

function setSelectedPanel(panel: SettingsTabPanelName): void {
  settingsState.selectedPanel.set(panel);
}

function getSelectedPanel(): SettingsTabPanelName {
  return settingsState.selectedPanel.get();
}

async function mountSettingsApp(
  initialTab: SettingsTabPanelName = 'account',
): Promise<LitElementLike> {
  const app = document.createElement('settings-app') as LitElementLike;
  app.setAttribute('data-desktop-view', 'settings');
  setSelectedPanel(initialTab);
  document.body.append(app);
  await app.updateComplete;
  return app;
}

function categoryButton(app: LitElementLike, label: string): HTMLElement {
  const button = [
    ...(app.shadowRoot?.querySelectorAll<HTMLElement>(
      '.settings-category-button',
    ) ?? []),
  ].find((candidate) => candidate.getAttribute('aria-label') === label);
  expect(button, `missing settings category "${label}"`).not.toBeNull();
  return button!;
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

describe('hierarchical settings navigation', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/SettingsApp');
    const nav = await import('@settingsView/frontend/settingsNav');
    settingsState = await import('@settingsView/frontend/settingsState');
    navGroups = nav.SETTINGS_NAV_GROUPS;
  });

  beforeEach(() => {
    setSelectedPanel('account');
  });

  it('selects the first page when changing category, then any page within it', async () => {
    const app = await mountSettingsApp();

    for (const group of navGroups) {
      categoryButton(app, group.label).click();
      await app.updateComplete;

      expect(getSelectedPanel()).toBe(group.entries[0]!.panel);
      expect(activePanelLabel(app)).toBe(group.entries[0]!.label);
      expect(
        app.shadowRoot?.querySelectorAll('.settings-page-button'),
      ).toHaveLength(group.entries.length);

      for (const entry of group.entries) {
        pageButton(app, entry.panel).click();
        await app.updateComplete;
        expect(getSelectedPanel()).toBe(entry.panel);
        expect(activePanelLabel(app)).toBe(entry.label);
      }
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

  it('keeps account key management in the models page', async () => {
    const app = await mountSettingsApp();

    const account =
      app.shadowRoot?.querySelector<LitElementLike>('account-tab');
    await account?.updateComplete;
    account?.dispatchEvent(
      new CustomEvent('manage-provider-keys', {
        bubbles: true,
        composed: true,
      }),
    );
    await app.updateComplete;

    expect(getSelectedPanel()).toBe('models');
    expect(activePanelLabel(app)).toBe('Providers & Models');
    expect(app.shadowRoot?.querySelector('models-tab')).not.toBeNull();
    expect(app.shadowRoot?.querySelector('account-tab')).toBeNull();
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
    expect(activePanelLabel(app)).toBe('Account & Usage');
    expect(app.shadowRoot?.querySelector('shortcuts-tab')).toBeNull();
  });
});
