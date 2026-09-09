/**
 * The host diagnostic port: one structured entry in, one host surface out.
 *
 * Hosts install a sink here (VS Code output channels, the desktop log file,
 * the CLI's console). Both diagnostic producers write the same entry through
 * it — `Effect.log*` via the logger layer in `@logger/effectDiagnostics`, and
 * the channel-keyed writers in `@logger/logUtils` that pre-Effect subsystems
 * still call. Neither producer formats: severity, timestamp, identity, and
 * payload stay separate fields the whole way, so a host renders them with its
 * own facilities instead of a downstream reader parsing them back out of a
 * line of text.
 *
 * Entries are secret-redacted here, once, before any host sees them. A host
 * may opt out only for a local operator terminal whose output is neither
 * persisted nor exported.
 */
// Third-party imports
import { Logger } from 'effect';

// Local imports
import { redactDisplayValue, redactSecrets } from '@logger/redaction';

/**
 * One diagnostic record, shaped by Effect's own structured formatter rather
 * than by a type of ours: `Logger.formatStructured` already carries level,
 * fiber, timestamp, message, cause, annotations, and spans, so the logger
 * layer maps straight onto this with no adaptation.
 */
export type LogEntry = ReturnType<typeof Logger.formatStructured.log>;

/** Annotation naming the logical channel an entry belongs to. */
export const LOG_CHANNEL = 'channel';

export interface LogSink {
  write(entry: LogEntry): void;
  dispose?(): void;
}

/**
 * Which channel an entry belongs to, or `undefined` when it names none. An
 * `Effect.log*` carries one only through `Effect.annotateLogs`; a tracer span
 * opened by `Effect.withSpan` does not supply it, because the entry's `spans`
 * field reads `CurrentLogSpans` (`Effect.withLogSpan`), a separate mechanism.
 * An unattributed entry lands on the host's shared surface, which is the right
 * home for it.
 */
export function entryChannel(entry: LogEntry): string | undefined {
  const channel = entry.annotations[LOG_CHANNEL];
  return typeof channel === 'string' ? channel : undefined;
}

/**
 * Render an entry's message for a host that wants one line of text. Effect
 * hands `message` through as a single value or an array of them, so both
 * shapes fold here rather than at each host.
 */
export function entryMessage(entry: LogEntry): string {
  const parts = Array.isArray(entry.message) ? entry.message : [entry.message];
  return parts
    .map((part) => (typeof part === 'string' ? part : JSON.stringify(part)))
    .join(' ');
}

function redactEntry(entry: LogEntry): LogEntry {
  return {
    ...entry,
    message: redactDisplayValue(entry.message),
    cause: entry.cause === undefined ? undefined : redactSecrets(entry.cause),
    annotations: redactDisplayValue(entry.annotations),
  };
}

/**
 * The console as a sink: the fallback for entries written before a host
 * installs its own, and the CLI's deliberate destination. Severity picks the
 * console method, so even this path keeps the level a reader can act on.
 */
export const consoleLogSink: LogSink = {
  write(entry) {
    const channel = entryChannel(entry);
    const line = `${channel ? `[${channel}] ` : ''}${entryMessage(entry)}`;
    switch (entry.level) {
      case 'FATAL':
      case 'ERROR':
        console.error(line);
        break;
      case 'WARN':
        console.warn(line);
        break;
      case 'DEBUG':
      case 'TRACE':
        console.debug(line);
        break;
      default:
        console.info(line);
    }
  },
};

let sink: LogSink = consoleLogSink;
let sinkTrusted = false;

/**
 * Install the host sink, disposing whatever it replaces. Entries are redacted
 * unless the host identifies a local operator terminal as trusted. Passing
 * `null` restores the console fallback.
 */
export function setLogSink(
  next: LogSink | null,
  options: { readonly trusted?: boolean } = {},
): void {
  if (sink !== consoleLogSink) sink.dispose?.();
  sink = next ?? consoleLogSink;
  sinkTrusted = options.trusted === true;
}

/** Write one entry to the installed sink. */
export function writeLogEntry(entry: LogEntry): void {
  sink.write(sinkTrusted ? entry : redactEntry(entry));
}
