import { z } from 'zod';

export const DESKTOP_SHELL_COMMANDS = {
  SET_ROUTE: 'desktop:setRoute',
} as const;

const DesktopRouteSchema = z.enum(['main', 'progress', 'settings', 'logs']);
export type DesktopRoute = z.infer<typeof DesktopRouteSchema>;

export const DesktopSetRouteMessageSchema = z.object({
  command: z.literal(DESKTOP_SHELL_COMMANDS.SET_ROUTE),
  route: DesktopRouteSchema,
});
