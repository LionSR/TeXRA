import { z } from 'zod';

export const DESKTOP_SHELL_COMMANDS = {
  OPEN_WORKBENCH: 'desktop:openWorkbench',
  SAVE_FILE: 'desktop:saveFile',
  SHOW_LAUNCHER: 'desktop:showLauncher',
  TOGGLE_LAYOUT: 'desktop:toggleLayout',
} as const;

const DesktopWorkbenchKindSchema = z.enum(['settings', 'logs']);
export type DesktopWorkbenchKind = z.infer<typeof DesktopWorkbenchKindSchema>;

export const DesktopOpenWorkbenchMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.OPEN_WORKBENCH),
  kind: DesktopWorkbenchKindSchema,
});

export const DesktopShowLauncherMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.SHOW_LAUNCHER),
});

export const DesktopSaveFileMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.SAVE_FILE),
});

const DesktopLayoutPanelSchema = z.enum([
  'bottomBar',
  'sidePanel',
  'summaryBar',
]);
export type DesktopLayoutPanel = z.infer<typeof DesktopLayoutPanelSchema>;

export const DesktopToggleLayoutMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT),
  panel: DesktopLayoutPanelSchema,
});
