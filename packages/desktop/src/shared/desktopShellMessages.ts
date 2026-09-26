import { z } from 'zod';

export const DESKTOP_SHELL_COMMANDS = {
  OPEN_WORKBENCH: 'desktop:openWorkbench',
  OPEN_SETTINGS: 'desktop:openSettings',
  SAVE_FILE: 'desktop:saveFile',
  TOGGLE_LAYOUT: 'desktop:toggleLayout',
} as const;

const DesktopWorkbenchKindSchema = z.enum(['logs']);
export type DesktopWorkbenchKind = z.infer<typeof DesktopWorkbenchKindSchema>;

export const DesktopOpenWorkbenchMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH),
  kind: DesktopWorkbenchKindSchema,
});

/** Settings is a popup dialog over the shell, not a workbench tab. */
export const DesktopOpenSettingsMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.OPEN_SETTINGS),
});

export const DesktopSaveFileMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.SAVE_FILE),
});

const DesktopLayoutPanelSchema = z.enum(['bottomBar', 'sidePanel']);
export type DesktopLayoutPanel = z.infer<typeof DesktopLayoutPanelSchema>;

export const DesktopToggleLayoutMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT),
  panel: DesktopLayoutPanelSchema,
});
