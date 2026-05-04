export const DESKTOP_SHELL_COMMANDS = {
  SET_ROUTE: 'desktop:setRoute',
} as const;

export type DesktopRoute = 'main' | 'progress' | 'settings';

export interface DesktopSetRouteMessage {
  command: typeof DESKTOP_SHELL_COMMANDS.SET_ROUTE;
  route: DesktopRoute;
}
