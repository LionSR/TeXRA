import { Schema } from 'effect';

export const DESKTOP_SHELL_COMMANDS = {
  OPEN_WORKBENCH: 'desktop:openWorkbench',
  OPEN_SETTINGS: 'desktop:openSettings',
  SAVE_FILE: 'desktop:saveFile',
  TOGGLE_LAYOUT: 'desktop:toggleLayout',
} as const;

const DesktopWorkbenchKindSchema = Schema.Literals(['logs']);
export type DesktopWorkbenchKind = typeof DesktopWorkbenchKindSchema.Type;

export const DesktopOpenWorkbenchMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH),
  kind: DesktopWorkbenchKindSchema,
});

/** Settings is a popup dialog over the shell, not a workbench tab. */
export const DesktopOpenSettingsMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_SHELL_COMMANDS.OPEN_SETTINGS),
});

export const DesktopSaveFileMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_SHELL_COMMANDS.SAVE_FILE),
});

const DesktopLayoutPanelSchema = Schema.Literals(['bottomBar', 'sidePanel']);
export type DesktopLayoutPanel = typeof DesktopLayoutPanelSchema.Type;

export const DesktopToggleLayoutMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT),
  panel: DesktopLayoutPanelSchema,
});
