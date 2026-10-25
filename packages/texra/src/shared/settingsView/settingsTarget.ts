/**
 * Where a settings link lands. A leaf over `effect` alone, so the session
 * shell's `openSettings` request can carry a target without pulling the
 * settings-view wire format into the conversation webview.
 */
import { Schema } from 'effect';

/**
 * The settings pages in nav order — single source of truth for tab names,
 * spelled the one way they travel: the panel name on the wire (`SET_TAB.tab`)
 * and in every `data-panel` selector.
 * Retired internal panels are removed together with their producers and
 * command surfaces so no stale IPC target remains.
 */
export const SETTINGS_TAB_ORDER = [
  'general',
  'models',
  'agents',
  'memory',
  'plugins',
  'latex',
] as const;

/**
 * Webview panel-addressing key for a tab, e.g. `'agents'`. A literal union
 * over {@link SETTINGS_TAB_ORDER}, so an appended tab widens it and
 * exhaustiveness-checked switches (SettingsApp's `renderActivePanel`) become
 * compile errors until they add a case — the same effect the
 * `Record<SettingsTabPanelName, …>` metadata maps have.
 */
export type SettingsTabPanelName = (typeof SETTINGS_TAB_ORDER)[number];

/**
 * Each page's sections in sub-tab order; a page with fewer than two shows no
 * second nav row. `vscode` (LaTeX) exists on the extension only.
 */
export const SETTINGS_PAGE_SECTIONS = {
  models: ['keys', 'subscriptions', 'models'],
  agents: ['library', 'teams', 'skills', 'advanced'],
  plugins: [],
  latex: ['dependencies', 'compile', 'formatting', 'vscode'],
  memory: [],
  general: ['appearance', 'approval', 'privacy', 'git'],
} as const satisfies Record<SettingsTabPanelName, readonly string[]>;

/** A section of page `P`, e.g. `'teams'` for `'agents'`. */
export type SettingsSectionName<
  P extends SettingsTabPanelName = SettingsTabPanelName,
> = (typeof SETTINGS_PAGE_SECTIONS)[P][number];

/**
 * Where a settings link lands: a page (on its remembered section), or one
 * section of it spelled `page/section`, e.g. `'agents/teams'`.
 */
export type SettingsTarget =
  | SettingsTabPanelName
  | {
      [P in SettingsTabPanelName]: `${P}/${SettingsSectionName<P>}`;
    }[SettingsTabPanelName];

export const SettingsTargetSchema = Schema.Literals(
  // cast: `flatMap` over the page table yields `string[]`; every element is a
  // page or one of its `page/section` pairs, which is exactly `SettingsTarget`.
  SETTINGS_TAB_ORDER.flatMap((page) => [
    page,
    ...SETTINGS_PAGE_SECTIONS[page].map((section) => `${page}/${section}`),
  ]) as [SettingsTarget, ...SettingsTarget[]],
);
