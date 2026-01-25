// Third-party imports
import { z } from 'zod';

// Local imports - shared commands
import { COMMON_COMMANDS } from '@common/webview/commands';

export const SetThemeMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.THEME_SET),
  theme: z.enum(['vscode-dark', 'vscode-light', 'vscode-high-contrast']),
});

export const SetDebugModeMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.DEBUG_MODE_SET),
  debugMode: z.boolean(),
});

export const StateRestoreMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.STATE_RESTORE),
  state: z.record(z.string(), z.unknown()).nullish(),
  executeImmediately: z.boolean().nullish(),
  isResetOperation: z.boolean().nullish(),
});

export const WebviewReadyMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.WEBVIEW_READY),
});

export const ErrorMessageSchema = z.object({
  command: z.literal(COMMON_COMMANDS.ERROR),
  message: z.string(),
  details: z.unknown().nullish(),
});

export const CommonViewMessageSchema = z.discriminatedUnion('command', [
  SetThemeMessageSchema,
  SetDebugModeMessageSchema,
  StateRestoreMessageSchema,
  WebviewReadyMessageSchema,
  ErrorMessageSchema,
]);

export type SetThemeMessage = z.infer<typeof SetThemeMessageSchema>;
export type SetDebugModeMessage = z.infer<typeof SetDebugModeMessageSchema>;
export type StateRestoreMessage = z.infer<typeof StateRestoreMessageSchema>;
export type WebviewReadyMessage = z.infer<typeof WebviewReadyMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type CommonViewMessage = z.infer<typeof CommonViewMessageSchema>;
