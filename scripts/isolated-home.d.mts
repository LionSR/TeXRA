export const HOME_DIRECTORY_KEYS: readonly [
  'HOME',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
];

export function isolatedHomeEnv(
  home: string,
): Record<(typeof HOME_DIRECTORY_KEYS)[number], string>;
