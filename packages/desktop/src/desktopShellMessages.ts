import { z } from 'zod';

export const DESKTOP_SHELL_COMMANDS = {
  SAVE_FILE: 'desktop:saveFile',
  SET_ROUTE: 'desktop:setRoute',
  TOGGLE_LAYOUT: 'desktop:toggleLayout',
} as const;

const DesktopRouteSchema = z.enum(['main', 'progress', 'settings', 'logs']);
export type DesktopRoute = z.infer<typeof DesktopRouteSchema>;

export const DesktopSetRouteMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.SET_ROUTE),
  route: DesktopRouteSchema,
});

export type DesktopSetRouteMessage = z.infer<
  typeof DesktopSetRouteMessageSchema
>;

export function buildDesktopSetRouteMessage(
  route: DesktopRoute,
): DesktopSetRouteMessage {
  return { command: DESKTOP_SHELL_COMMANDS.SET_ROUTE, route };
}

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
