/**
 * Capture the diagnostic entries a subsystem writes.
 *
 * Every producer — `Effect.log*` through the logger layer and the direct
 * `writeLogEntry` publication points — ends at the one host sink, so a
 * suite asserts on the entries that reach it rather than on whichever producer
 * the code under test happens to use. The capture holds for the caller's
 * scope, whose release puts the console fallback back.
 */
import { Effect } from 'effect';

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

/** Route diagnostics into an in-memory list for the caller's scope. */
export const captureLogEntries = Effect.acquireRelease(
  Effect.sync(() => {
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
    return captured;
  }),
  () => Effect.sync(() => setLogSink(null)),
).pipe(Effect.map(captureOf));

function captureOf(captured: readonly CapturedLog[]): LogCapture {
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
