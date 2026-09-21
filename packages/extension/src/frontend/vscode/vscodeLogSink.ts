/**
 * VS Code's own log surface as the extension's diagnostic sink.
 *
 * A `LogOutputChannel` (`{ log: true }`) supplies the timestamp, the severity
 * tag, a user-selectable level, and the Output view's level filter, so nothing
 * here formats a line: an entry's level picks the channel method and the rest
 * is the message. One channel serves the whole extension — a run's events are
 * the transcript's to render, not a per-run output channel's.
 */
// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { formatLogData } from '@logger/formatLogData';
import {
  LOG_CHANNEL,
  LOG_DATA,
  entryChannel,
  entryMessage,
  type LogEntry,
  type LogSink,
} from '@logger/logSink';
import { isDebugModeEnabled } from '@logger/logUtils';

/** Everything the channel itself does not already render. Entries carry the
 * `data` payload raw, so it is flattened here for display — and shown only in
 * debug mode, the same terms `createLog` writes it on. */
function detail(entry: LogEntry): string {
  const debugMode = isDebugModeEnabled();
  const extra = Object.entries(entry.annotations)
    .filter(([key]) => key !== LOG_CHANNEL && (key !== LOG_DATA || debugMode))
    .map(([key, value]): [string, string] => [
      key,
      typeof value === 'string' ? value : formatLogData(value),
    ]);
  const parts = [
    entry.cause,
    extra.length === 0 ? undefined : JSON.stringify(Object.fromEntries(extra)),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : `\n${parts.join('\n')}`;
}

export function createVsCodeLogSink(): LogSink {
  let output: vscode.LogOutputChannel | undefined;

  return {
    write(entry) {
      output ??= vscode.window.createOutputChannel('TeXRA', { log: true });
      const channel = entryChannel(entry);
      const prefix = channel === undefined ? '' : `[${channel}] `;
      const line = `${prefix}${entryMessage(entry)}${detail(entry)}`;
      switch (entry.level) {
        case 'FATAL':
        case 'ERROR':
          output.error(line);
          break;
        case 'WARN':
          output.warn(line);
          break;
        case 'DEBUG':
          output.debug(line);
          break;
        case 'TRACE':
          output.trace(line);
          break;
        default:
          output.info(line);
      }
    },

    dispose() {
      output?.dispose();
      output = undefined;
    },
  };
}
