import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChannelTrace } from '@agent/trace';
import { setLogSink, type LogEntry } from '@logger/logSink';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('channel trace adapters', () => {
  afterEach(() => {
    setLogSink(null);
  });

  /** Capture the entries the adapters emit. */
  function captureEntries(): LogEntry[] {
    const entries: LogEntry[] = [];
    setLogSink({ write: (entry) => entries.push(entry) });
    return entries;
  }

  const messages = (entries: readonly LogEntry[]): string =>
    entries.map((entry) => String(entry.message)).join('\n');

  it('routes debug/info/warn/error through the functional per-channel sink', () => {
    const entries = captureEntries();
    const trace = createChannelTrace('TestChannel');

    trace.debug('a debug line');
    trace.info('an info line');
    trace.warn('a warn line');
    trace.error('an error line');

    expect(entries.map((entry) => entry.level)).toStrictEqual([
      'DEBUG',
      'INFO',
      'WARN',
      'ERROR',
    ]);
    expect(
      entries.every((e) => e.annotations['channel'] === 'TestChannel'),
    ).toBe(true);
  });

  it('suppresses INTERNAL-tagged lines', () => {
    const entries = captureEntries();
    const trace = createChannelTrace('TestChannel');

    trace.info('internal-only line', { messageType: MESSAGE_TYPES.INTERNAL });
    trace.info('visible line');

    const output = messages(entries);
    expect(output).not.toContain('internal-only line');
    expect(output).toContain('visible line');
  });
});
