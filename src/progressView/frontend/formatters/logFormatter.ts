// Local imports - formatters
import { getSharedLogEntryFormatter } from './index.js';

// Local types
import type { LogMessageData } from '@shared/schemas';

export interface LogFormatterOptions {
  preservedOpen?: boolean;
  defaultOpen?: boolean;
}

export function formatLogEntry(
  log: LogMessageData,
  options: LogFormatterOptions = {},
) {
  return getSharedLogEntryFormatter().format(log, options);
}
