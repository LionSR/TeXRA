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
import type { LogSink } from '@texra-ai/harness/node';
import { entryDetail, entryLine } from '@texra-ai/harness/schemas';

export function createVsCodeLogSink(): LogSink {
  let output: vscode.LogOutputChannel | undefined;

  return {
    write(entry) {
      output ??= vscode.window.createOutputChannel('TeXRA', { log: true });
      // Every annotation arrives rendered and bounded by the write path, so
      // the detail shows them on the entries the channel's level filter let
      // through.
      const line = [entryLine(entry), ...entryDetail(entry)].join('\n');
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
        case 'INFO':
          output.info(line);
      }
    },

    dispose() {
      output?.dispose();
      output = undefined;
    },
  };
}
