import { Schema } from 'effect';
import { SettingsTargetSchema } from '@texra/shared/settingsView/settingsTarget';

export const DESKTOP_SHELL_COMMANDS = {
  OPEN_SETTINGS: 'desktop:openSettings',
  RUN_COMMAND: 'desktop:runCommand',
} as const;

/** Settings is a popup dialog over the shell, not a workbench tab. It opens
 *  on `tab` when one is named, else where it was left. */
export const DesktopOpenSettingsMessageSchema = Schema.Struct({
  command: Schema.Literal(DESKTOP_SHELL_COMMANDS.OPEN_SETTINGS),
  tab: Schema.optional(SettingsTargetSchema),
});
