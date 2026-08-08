import { z } from 'zod';

import { COMMON_COMMANDS } from '@shared/ipc';
// Import from the leaf state module, not the ./mainView barrel: the barrel
// re-exports ./inbound, which imports this file — going through the barrel
// would close a load-time cycle.
import { MainViewPersistedStateSchema } from './mainView/state';

/** Theme values - single source of truth for all theme schemas */
export const ThemeSchema = z.enum(['dark', 'light', 'high-contrast']);
export type Theme = z.infer<typeof ThemeSchema>;

/** Theme kinds as reported by the Electron desktop host. */
export const DESKTOP_THEME_KIND = {
  DARK: 'dark',
  LIGHT: 'light',
  HIGH_CONTRAST: 'high-contrast',
} as const satisfies Record<string, Theme>;

export type DesktopThemeKind = Theme;

export const SetThemeMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.THEME_SET),
  theme: ThemeSchema,
});

const SetDebugModeMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

const StateRestoreMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.STATE_RESTORE),
  state: MainViewPersistedStateSchema.nullish(),
  executeImmediately: z.boolean().nullish(),
  isResetOperation: z.boolean().nullish(),
});

export const WebviewReadyMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.WEBVIEW_READY),
  view: z.enum(['main', 'progress', 'settings']).nullish(),
});

const SwitchViewTargetSchema = z.enum(['main', 'progress', 'dashboard']);

export const SwitchViewMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.SWITCH_VIEW),
  view: SwitchViewTargetSchema,
  openInEditor: z.boolean().nullish(),
});

const ErrorMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.ERROR),
  message: z.string(),
  details: z.unknown().nullish(),
});

export const CommonViewMessageSchema = z.discriminatedUnion('command', [
  SetThemeMessageSchema,
  SetDebugModeMessageSchema,
  StateRestoreMessageSchema,
  WebviewReadyMessageSchema,
  SwitchViewMessageSchema,
  ErrorMessageSchema,
]);

export type StateRestoreMessage = z.infer<typeof StateRestoreMessageSchema>;
