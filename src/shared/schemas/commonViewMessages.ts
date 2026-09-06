import { z } from 'zod';

import { COMMON_COMMANDS } from '@shared/ipc';
/** Theme values - single source of truth for all theme schemas */
const ThemeSchema = z.enum(['dark', 'light', 'high-contrast']);
export type Theme = z.infer<typeof ThemeSchema>;

/** Theme kinds as reported by the Electron desktop host. */
export const DESKTOP_THEME_KIND = {
  DARK: 'dark',
  LIGHT: 'light',
  HIGH_CONTRAST: 'high-contrast',
} as const satisfies Record<string, Theme>;

export const WebviewReadyMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.WEBVIEW_READY),
  view: z.enum(['main', 'progress', 'settings']).nullish(),
});
