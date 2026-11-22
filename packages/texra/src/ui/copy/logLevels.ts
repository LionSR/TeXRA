/**
 * How a log level reads in every web renderer: its word and its icon, so the
 * progress view's log lines and the desktop Logs tab cannot mark one severity
 * two ways. Each host colours the icon from its own level classes.
 */
import type { LogLevel } from '@texra-ai/worldline/schemas';
import type { IconName } from '@ui/wa/iconNames';

export interface LogLevelLook {
  readonly icon: IconName;
  readonly label: string;
}

export const LOG_LEVEL_LOOK: Readonly<Record<LogLevel, LogLevelLook>> =
  Object.freeze({
    error: Object.freeze({ icon: 'circle-exclamation', label: 'Error' }),
    warn: Object.freeze({ icon: 'triangle-exclamation', label: 'Warning' }),
    info: Object.freeze({ icon: 'circle-info', label: 'Info' }),
    debug: Object.freeze({ icon: 'code', label: 'Debug' }),
  });
