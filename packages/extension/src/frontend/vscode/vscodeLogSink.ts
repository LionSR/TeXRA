/**
 * VS Code's own log surface as the extension's diagnostic sink.
 *
 * A `LogOutputChannel` (`{ log: true }`) supplies the timestamp, the severity
 * tag, a user-selectable level, and the Output view's level filter, so nothing
 * here formats a line: an entry's level picks the channel method and the rest
 * is the message. A run-scoped channel gets its own output channel, disposed
 * when the run releases it.
 */
// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  LOG_CHANNEL,
  LOG_SCOPE,
  entryChannel,
  entryMessage,
  isRunScoped,
  type LogEntry,
  type LogSink,
} from '@logger/logSink';

const SHARED_CHANNEL_NAME = 'TeXRA';

function runChannelName(channel: string): string {
  return `${SHARED_CHANNEL_NAME} ${channel}`;
}

/** Everything the channel itself does not already render. */
function detail(entry: LogEntry): string {
  const extra = Object.entries(entry.annotations).filter(
    ([key]) => key !== LOG_CHANNEL && key !== LOG_SCOPE,
  );
  const parts = [
    entry.cause,
    extra.length === 0 ? undefined : JSON.stringify(Object.fromEntries(extra)),
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : `\n${parts.join('\n')}`;
}

export function createVsCodeLogSink(): LogSink {
  const channels = new Map<string, vscode.LogOutputChannel>();

  const channelFor = (name: string): vscode.LogOutputChannel => {
    const existing = channels.get(name);
    if (existing) return existing;
    const created = vscode.window.createOutputChannel(name, { log: true });
    channels.set(name, created);
    return created;
  };

  return {
    write(entry) {
      const channel = entryChannel(entry);
      const runScoped = isRunScoped(entry) && channel !== undefined;
      const output = channelFor(
        runScoped ? runChannelName(channel) : SHARED_CHANNEL_NAME,
      );
      // A run has its own channel, so only the shared one names its source.
      const prefix = runScoped || channel === undefined ? '' : `[${channel}] `;
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

    disposeRun(channel) {
      const name = runChannelName(channel);
      const output = channels.get(name);
      if (!output) return;
      channels.delete(name);
      output.dispose();
    },

    dispose() {
      for (const output of channels.values()) output.dispose();
      channels.clear();
    },
  };
}
