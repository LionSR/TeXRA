import { z } from 'zod';

export const DESKTOP_SHELL_COMMANDS = {
  SET_ROUTE: 'desktop:setRoute',
  TOGGLE_LAYOUT: 'desktop:toggleLayout',
} as const;

const DesktopRouteSchema = z.enum(['main', 'progress', 'settings', 'logs']);
export type DesktopRoute = z.infer<typeof DesktopRouteSchema>;

export const DesktopSetRouteMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.SET_ROUTE),
  route: DesktopRouteSchema,
});

export const DesktopLayoutPanelSchema = z.enum([
  'bottomBar',
  'sidePanel',
  'summaryBar',
]);
export type DesktopLayoutPanel = z.infer<typeof DesktopLayoutPanelSchema>;

export const DesktopToggleLayoutMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.TOGGLE_LAYOUT),
  panel: DesktopLayoutPanelSchema,
});
