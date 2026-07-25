// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `hostBridge` is part of the mock because <history-tab> constructs a
// PersistedState over it. jsdom swallows throws inside a custom-element upgrade
// reaction, so omitting it doesn't fail the test — it just silently leaves one
// panel's element unconstructed.
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

// Local imports - tab wire format (schema-only; safe to import before jsdom)
import {
  SETTINGS_TAB,
  SETTINGS_TAB_ORDER,
  SETTINGS_TAB_PANEL_BY_NAME,
} from '@shared/schemas';

// Local imports - test utilities
import { useLitComponentTestDom } from './litComponentTestUtils';

type LitElementLike = HTMLElement & { updateComplete: Promise<unknown> };

interface NavEntry {
  readonly name: keyof typeof SETTINGS_TAB;
  readonly panel: string;
  readonly label: string;
}

// Loaded inside the DOM setup, not at module scope: lit captures `document`
// when it is first imported, so any module that pulls in lit (SettingsApp, the
// nav table via the icon helpers, the state signals) must load after
// useLitComponentTestDom has installed the jsdom globals.
let navGroups: readonly { label: string; entries: readonly NavEntry[] }[] = [];
let navEntries: readonly NavEntry[] = [];
let setSelectedTabIndex: (index: number) => void = () => {};
let getSelectedTabIndex: () => number = () => -1;
let declareAllCommandsSupported: () => void = () => {};

async function mountSettingsApp(): Promise<LitElementLike> {
  const app = document.createElement('settings-app') as LitElementLike;
  // SettingsApp's constructor resets the module-scope signals, so the host
  // capability set has to be declared after construction.
  declareAllCommandsSupported();
  document.body.append(app);
  await app.updateComplete;
  // wa-tab-group syncs tabs to panels from a slotchange plus an
  // IntersectionObserver callback, so the initial activation lands a macrotask
  // after the host's first update.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return app;
}

function navRow(app: LitElementLike, panel: string): HTMLElement {
  const tab = app.shadowRoot?.querySelector<HTMLElement>(
    `wa-tab[panel="${panel}"]`,
  );
  expect(tab, `missing nav row for panel "${panel}"`).not.toBeNull();
  return tab!;
}

function activePanelName(app: LitElementLike): string | null | undefined {
  return app.shadowRoot
    ?.querySelector('wa-tab-panel[active]')
    ?.getAttribute('name');
}

/**
 * The grouped left-nav is presentation only: rows address panels by name and
 * `SettingsApp.handleTabShow` maps the name back to the `SETTINGS_TAB` index
 * that travels over IPC. These tests exercise that round trip through the real
 * component, so a regrouping that broke it fails here instead of silently
 * opening the wrong panel.
 */
describe('settings nav navigation', () => {
  useLitComponentTestDom(async () => {
    await import('@settingsView/frontend/SettingsApp');
    const nav = await import('@settingsView/frontend/settingsNav');
    const state = await import('@settingsView/frontend/settingsState');
    navGroups = nav.SETTINGS_NAV_GROUPS as typeof navGroups;
    navEntries = navGroups.flatMap((group) => group.entries);
    setSelectedTabIndex = (index) => state.selectedTabIndex.set(index);
    getSelectedTabIndex = () => state.selectedTabIndex.get();
    // `unsupportedCommands` starts as null ("nothing known yet"), which
    // `isKnownUnsupported` treats as unsupported and which hides the Goals row.
    // An empty set is the host saying every command is available.
    declareAllCommandsSupported = () =>
      state.unsupportedCommands.set(new Set<string>());
  });

  beforeEach(() => {
    setSelectedTabIndex(0);
  });

  it('renders one nav row per tab, grouped under headings', async () => {
    const app = await mountSettingsApp();

    const panels = [...(app.shadowRoot?.querySelectorAll('wa-tab') ?? [])].map(
      (tab) => tab.getAttribute('panel'),
    );
    const headings = [
      ...(app.shadowRoot?.querySelectorAll('.settings-nav-group') ?? []),
    ].map((heading) => heading.textContent?.trim());

    expect(panels).toEqual(navEntries.map((entry) => entry.panel));
    expect(panels).toHaveLength(SETTINGS_TAB_ORDER.length);
    expect(headings).toEqual(navGroups.map((group) => group.label));
  });

  it('activates the panel matching each nav row and reports its wire index', async () => {
    const app = await mountSettingsApp();

    for (const entry of navEntries) {
      navRow(app, entry.panel).click();
      await app.updateComplete;

      expect(activePanelName(app)).toBe(entry.panel);
      expect(getSelectedTabIndex()).toBe(SETTINGS_TAB[entry.name]);
    }
  });

  it('activates the panel addressed by a SET_TAB wire index', async () => {
    const app = await mountSettingsApp();

    setSelectedTabIndex(SETTINGS_TAB.LATEX);
    await app.updateComplete;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(activePanelName(app)).toBe('latex');
    expect(
      app.shadowRoot?.querySelector('wa-tab[panel="latex"][active]'),
    ).not.toBeNull();
  });

  it('keeps group headings out of the tab list', async () => {
    // wa-tab-group builds its tab list from slot[name="nav"] filtered to
    // wa-tab, which is what lets a heading share the column without becoming a
    // focusable pseudo-tab bound to no panel.
    const app = await mountSettingsApp();
    const heading = app.shadowRoot?.querySelector<HTMLElement>(
      '.settings-nav-group',
    );
    // A row has to be activated first: nothing is active at mount here (WA's
    // initial activation runs from an IntersectionObserver the test DOM does not
    // provide), so asserting "unchanged" against no active panel would pass for
    // a heading that does steal activation.
    navRow(app, SETTINGS_TAB_PANEL_BY_NAME.LATEX).click();
    await app.updateComplete;
    expect(activePanelName(app)).toBe(SETTINGS_TAB_PANEL_BY_NAME.LATEX);

    heading?.click();
    await app.updateComplete;

    expect(heading?.getAttribute('role')).toBe('presentation');
    expect(heading?.matches('wa-tab')).toBe(false);
    expect(activePanelName(app)).toBe(SETTINGS_TAB_PANEL_BY_NAME.LATEX);
  });

  it('names every nav row for the icon-only collapsed layout', async () => {
    // The container query at 620px hides the label span, and waIcon() emits
    // aria-hidden, so the aria-label is the row's only accessible name in a
    // quarter-pane. The group name is folded in because it is the heading text
    // that aria-hidden removes from the tablist.
    const app = await mountSettingsApp();

    for (const group of navGroups) {
      for (const entry of group.entries) {
        expect(navRow(app, entry.panel).getAttribute('aria-label')).toBe(
          `${group.label}: ${entry.label}`,
        );
      }
    }
  });
});
