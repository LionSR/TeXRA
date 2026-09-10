/**
 * Capture the diagnostic entries a subsystem writes.
 *
 * Both producers — `Effect.log*` through the logger layer and the
 * channel-keyed writers in `@logger/logUtils` — end at the one host sink, so a
 * suite asserts on the entries that reach it rather than on whichever producer
 * the code under test happens to use. Install with `captureLogEntries()` and
 * restore with `setLogSink(null)` in `afterEach`.
 */
import { entryChannel, entryMessage, setLogSink } from '@logger/logSink';
import type { LogEntry } from '@logger/logSink';

interface CapturedLog {
  readonly level: string;
  readonly channel: string | undefined;
  readonly message: string;
  readonly annotations: LogEntry['annotations'];
}

export interface LogCapture {
  /** Every entry written since the capture was installed, in order. */
  readonly entries: () => readonly CapturedLog[];
  /** Entries at `level`, optionally narrowed to one channel. */
  readonly at: (level: string, channel?: string) => readonly CapturedLog[];
  /** Whether some entry at `level` on `channel` contains `text`. */
  readonly has: (level: string, channel: string, text: string) => boolean;
}

/** Route diagnostics into an in-memory list for the current test. */
export function captureLogEntries(): LogCapture {
  const captured: CapturedLog[] = [];
  setLogSink({
    write: (entry) =>
      captured.push({
        level: entry.level,
        channel: entryChannel(entry),
        message: entryMessage(entry),
        annotations: entry.annotations,
      }),
  });

  const at = (level: string, channel?: string): readonly CapturedLog[] =>
    captured.filter(
      (entry) =>
        entry.level === level &&
        (channel === undefined || entry.channel === channel),
    );

  return {
    entries: () => captured,
    at,
    has: (level, channel, text) =>
      at(level, channel).some((entry) => entry.message.includes(text)),
  };
}
