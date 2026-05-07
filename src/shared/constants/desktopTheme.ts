import type { Theme } from '@shared/schemas/commonViewMessages';

export const DESKTOP_THEME_KIND = {
  DARK: 'dark',
  LIGHT: 'light',
  HIGH_CONTRAST: 'high-contrast',
} as const satisfies Record<string, Theme>;

export type DesktopThemeKind = Theme;
