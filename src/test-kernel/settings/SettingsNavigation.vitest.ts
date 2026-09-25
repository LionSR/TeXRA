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

function sectionTabs(app: LitElementLike): HTMLElement[] {
  return [
    ...(app.shadowRoot?.querySelectorAll<HTMLElement>(
      '.settings-section-button',
    ) ?? []),
  ];
}

function activeSection(app: LitElementLike): string | undefined {
  return sectionTabs(app).find(
    (tab) => tab.getAttribute('aria-selected') === 'true',
  )?.dataset.section;
}

function activePanelLabel(app: LitElementLike): string | null | undefined {
  return app.shadowRoot
    ?.querySelector('.settings-panel')
    ?.getAttribute('aria-label');
}

describe('settings navigation', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/SettingsApp');
    const nav = await import('@settingsView/frontend/settingsNav');
    settingsState = await import('@settingsView/frontend/settingsState');
    navEntries = nav.SETTINGS_NAV_ENTRIES;
  });

  beforeEach(() => {
    setSelectedPanel('models');
  });

  it('shows every page in one strip and a sub-tab row only for multi-section pages', async () => {
    const app = await mountSettingsApp();

    expect(
      app.shadowRoot?.querySelectorAll('.settings-page-nav [role="tab"]'),
    ).toHaveLength(navEntries.length + navEntries[0].sections.length);
    for (const entry of navEntries) {
      pageButton(app, entry.panel).click();
      await app.updateComplete;
      expect(getSelectedPanel()).toBe(entry.panel);
      expect(activePanelLabel(app)).toBe(entry.label);
      expect(pageButton(app, entry.panel).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(sectionTabs(app).map((tab) => tab.dataset.section)).toEqual(
        entry.sections.length < 2
          ? []
          : entry.sections
              .map((s) => s.section)
              // Mounted as the desktop, which has no VS Code settings.
              .filter((section) => section !== 'vscode'),
      );
    }
  });

  it('lands a page/section link on its sub-tab, remembers it, and moves with arrow keys', async () => {
    const app = await mountSettingsApp();
    window.dispatchEvent(
      new window.MessageEvent('message', {
        data: { command: 'setTab', tab: 'agents/teams' },
      }),
    );
    await app.updateComplete;

    expect(activePanelLabel(app)).toBe('Agents');
    expect(activeSection(app)).toBe('teams');
    expect(
      app.shadowRoot
        ?.querySelector('agents-tab')
        ?.shadowRoot?.querySelector('slot[name="teams"]'),
    ).not.toBeNull();

    // Leaving the page and coming back keeps the sub-tab.
    pageButton(app, 'models').click();
    await app.updateComplete;
    expect(activeSection(app)).toBe('keys');
    pageButton(app, 'agents').click();
    await app.updateComplete;
    expect(activeSection(app)).toBe('teams');

    // Roving focus: only the selected tab is in the tab order, and an arrow
    // key selects the next one.
    const teams = sectionTabs(app).find((t) => t.dataset.section === 'teams')!;
    expect(sectionTabs(app).map((t) => t.getAttribute('tabindex'))).toEqual([
      '-1',
      '0',
      '-1',
      '-1',
    ]);
    teams.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
        composed: true,
      }),
    );
    await app.updateComplete;
    expect(activeSection(app)).toBe('skills');
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
