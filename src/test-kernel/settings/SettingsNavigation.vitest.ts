import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@shared/hostBridge', () => ({
  postMessage: vi.fn(),
  getState: () => ({}),
  setState: () => {},
  hostBridge: {
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  },
}));

import type { SettingsNavGroup } from '@settingsView/frontend/settingsNav';
import { postMessage } from '@shared/hostBridge';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { SETTINGS_TAB, SETTINGS_TAB_PANEL_BY_NAME } from '@shared/schemas';

import {
  mountComponent,
  useLitComponentTestDom,
} from './litComponentTestUtils';

type LitElementLike = HTMLElement & { updateComplete: Promise<unknown> };

const MAX_TIMEOUT_MS = 2_147_483_647;
const THIRTY_ONE_DAYS_MS = 31 * 24 * 60 * 60 * 1_000;

let navGroups: readonly SettingsNavGroup[] = [];
let settingsState: typeof import('@settingsView/frontend/settingsState');

function setSelectedTabIndex(index: number): void {
  settingsState.selectedTabIndex.set(index);
}

function getSelectedTabIndex(): number {
  return settingsState.selectedTabIndex.get();
}

function declareAllCommandsSupported(): void {
  settingsState.unsupportedCommands.set(new Set<string>());
}

async function mountSettingsApp(
  initialTab = SETTINGS_TAB.ACCOUNT,
): Promise<LitElementLike> {
  const app = document.createElement('settings-app') as LitElementLike;
  app.setAttribute('data-desktop-view', 'settings');
  declareAllCommandsSupported();
  setSelectedTabIndex(initialTab);
  document.body.append(app);
  await app.updateComplete;
  return app;
}

async function withFakeTimers(
  systemTime: string,
  run: () => Promise<void>,
): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(systemTime));
  try {
    await run();
  } finally {
    vi.useRealTimers();
  }
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
    setSelectedTabIndex(SETTINGS_TAB.ACCOUNT);
  });

  it('refreshes settings at the UTC monthly quota rollover', async () => {
    await withFakeTimers('2026-08-31T23:59:59.000Z', async () => {
      const app = await mountSettingsApp();
      vi.mocked(postMessage).mockClear();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(postMessage).toHaveBeenCalledExactlyOnceWith(
        SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        { view: 'settings' },
      );
      app.remove();
      vi.mocked(postMessage).mockClear();
      await vi.advanceTimersByTimeAsync(THIRTY_ONE_DAYS_MS);
      expect(postMessage).not.toHaveBeenCalled();
    });
  });

  it('follows the max-delay clamp through a 31-day UTC month boundary', async () => {
    await withFakeTimers('2026-07-01T00:00:00.000Z', async () => {
      const app = await mountSettingsApp();
      vi.mocked(postMessage).mockClear();

      await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS);
      expect(postMessage).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(THIRTY_ONE_DAYS_MS - MAX_TIMEOUT_MS);
      expect(postMessage).toHaveBeenCalledExactlyOnceWith(
        SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        { view: 'settings' },
      );
      app.remove();
    });
  });

  it('refreshes exactly once at rollover after disconnecting and reconnecting', async () => {
    await withFakeTimers('2026-08-31T23:59:58.000Z', async () => {
      const app = await mountSettingsApp();
      vi.mocked(postMessage).mockClear();

      await vi.advanceTimersByTimeAsync(500);
      app.remove();
      await vi.advanceTimersByTimeAsync(500);
      document.body.append(app);
      await app.updateComplete;
      vi.mocked(postMessage).mockClear();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(postMessage).toHaveBeenCalledExactlyOnceWith(
        SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        { view: 'settings' },
      );
      app.remove();
    });
  });

  it('renders category navigation plus only the active category pages', async () => {
    const app = await mountSettingsApp();

    expect(
      app.shadowRoot?.querySelectorAll('.settings-category-button'),
    ).toHaveLength(navGroups.length);
    const activeGroup = navGroups.find((group) =>
      group.entries.some((entry) => entry.name === 'ACCOUNT'),
    )!;
    expect(
      app.shadowRoot?.querySelectorAll('.settings-page-button'),
    ).toHaveLength(activeGroup.entries.length);
  });

  it('selects the first page when changing category, then any page within it', async () => {
    const app = await mountSettingsApp();

    for (const group of navGroups) {
      categoryButton(app, group.label).click();
      await app.updateComplete;

      expect(getSelectedTabIndex()).toBe(SETTINGS_TAB[group.entries[0]!.name]);
      expect(activePanelLabel(app)).toBe(group.entries[0]!.label);
      expect(
        app.shadowRoot?.querySelectorAll('.settings-page-button'),
      ).toHaveLength(group.entries.length);

      for (const entry of group.entries) {
        pageButton(app, entry.panel).click();
        await app.updateComplete;
        expect(getSelectedTabIndex()).toBe(SETTINGS_TAB[entry.name]);
        expect(activePanelLabel(app)).toBe(entry.label);
      }
    }
  });

  it('activates the page addressed by a wire index', async () => {
    const app = await mountSettingsApp(SETTINGS_TAB.LATEX);

    expect(activePanelLabel(app)).toBe('LaTeX');
    expect(
      app.shadowRoot?.querySelector(
        '.settings-page-button[data-panel="latex"][data-active="true"]',
      ),
    ).not.toBeNull();
    expect(app.shadowRoot?.querySelector('latex-tab')).not.toBeNull();
  });

  it('renders the same page heading contract for every settings page', async () => {
    const app = await mountSettingsApp();

    for (const group of navGroups) {
      for (const entry of group.entries) {
        setSelectedTabIndex(SETTINGS_TAB[entry.name]);
        await app.updateComplete;

        const header = app.shadowRoot?.querySelector('.settings-page-header');
        expect(header?.querySelector('h1')?.textContent?.trim()).toBe(
          entry.label,
        );
        expect(header?.querySelector('p')?.textContent?.trim()).toBe(
          entry.description,
        );
        expect(header?.querySelector('wa-icon')).toBeNull();
      }
    }
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

    expect(getSelectedTabIndex()).toBe(SETTINGS_TAB.MODELS);
    expect(activePanelLabel(app)).toBe('Providers & Models');
    expect(app.shadowRoot?.querySelector('models-tab')).not.toBeNull();
    expect(app.shadowRoot?.querySelector('account-tab')).toBeNull();
  });

  it('keeps icon-only navigation controls accessible', async () => {
    const app = await mountSettingsApp();

    for (const group of navGroups) {
      expect(categoryButton(app, group.label).getAttribute('aria-label')).toBe(
        group.label,
      );
      categoryButton(app, group.label).click();
      await app.updateComplete;
      for (const entry of group.entries) {
        expect(pageButton(app, entry.panel).getAttribute('aria-label')).toBe(
          `${group.label}: ${entry.label}`,
        );
      }
    }
  });

  it('keeps unsupported Goals out of the Data & Activity pages', async () => {
    const app = await mountComponent<LitElementLike>('settings-app');

    const dataGroup = navGroups.find(
      (group) => group.label === 'Data & Activity',
    )!;
    categoryButton(app, dataGroup.label).click();
    await app.updateComplete;

    expect(
      app.shadowRoot?.querySelector(
        `.settings-page-button[data-panel="${SETTINGS_TAB_PANEL_BY_NAME.GOAL}"]`,
      ),
    ).toBeNull();
  });

  it('keeps desktop-only shortcuts out of the extension navigation', async () => {
    const app = document.createElement('settings-app') as LitElementLike;
    declareAllCommandsSupported();
    setSelectedTabIndex(SETTINGS_TAB.SHORTCUTS);
    document.body.append(app);
    await app.updateComplete;

    expect(
      app.shadowRoot?.querySelector(
        `.settings-page-button[data-panel="${SETTINGS_TAB_PANEL_BY_NAME.SHORTCUTS}"]`,
      ),
    ).toBeNull();
    expect(activePanelLabel(app)).toBe('Account & Usage');
    expect(app.shadowRoot?.querySelector('shortcuts-tab')).toBeNull();
  });
});
