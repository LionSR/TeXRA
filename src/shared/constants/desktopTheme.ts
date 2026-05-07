import type { Theme } from '@shared/schemas/commonViewMessages';

export const DESKTOP_THEME_KIND = {
  DARK: 'dark',
  LIGHT: 'light',
  HIGH_CONTRAST: 'high-contrast',
} as const satisfies Record<string, Theme>;

export type DesktopThemeKind = Theme;

export const DESKTOP_THEME_KINDS = Object.values(
  DESKTOP_THEME_KIND,
) as DesktopThemeKind[];

export function isDesktopThemeKind(theme: string): theme is DesktopThemeKind {
  return DESKTOP_THEME_KINDS.includes(theme as DesktopThemeKind);
}
