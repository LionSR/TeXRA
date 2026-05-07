export const DESKTOP_THEME_KIND = {
  DARK: 'dark',
  LIGHT: 'light',
  HIGH_CONTRAST: 'high-contrast',
} as const;

export type DesktopThemeKind =
  (typeof DESKTOP_THEME_KIND)[keyof typeof DESKTOP_THEME_KIND];

export const DESKTOP_THEME_KINDS = Object.values(
  DESKTOP_THEME_KIND,
) as DesktopThemeKind[];

export function isDesktopThemeKind(theme: string): theme is DesktopThemeKind {
  return DESKTOP_THEME_KINDS.includes(theme as DesktopThemeKind);
}
