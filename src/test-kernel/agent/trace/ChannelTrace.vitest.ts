import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachChannelSubscriber,
  createChannelTrace,
  TraceEmitter,
} from '@agent/trace';
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

  it('keeps non-log AgentTrace members inert', () => {
    const trace = createChannelTrace('TestChannel');

    const unsubscribe = trace.subscribe(() => {
      throw new Error('a channel trace must never fan out to subscribers');
    });
    expect(() =>
      trace.emit({ type: 'log', level: 'info', message: 'x' }),
    ).not.toThrow();
    unsubscribe();

    expect(trace.activeStageId()).toBeUndefined();

    const stage = trace.openStage('stage');
    expect(() => stage.end()).not.toThrow();

    const stream = trace.openStream(MESSAGE_TYPES.MODEL_RESPONSE);
    stream.append('chunk');
    expect(stream.finalize()).toBe('');
  });

  it('routes public emitter logs until the subscriber is detached', () => {
    const entries = captureEntries();
    const trace = new TraceEmitter();
    const detach = attachChannelSubscriber(trace, 'AgentChannel');

    trace.info('visible emitter line');
    trace.info('internal emitter line', {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
    detach();
    trace.info('detached emitter line');

    const output = messages(entries);
    expect(output).toContain('visible emitter line');
    expect(output).not.toContain('internal emitter line');
    expect(output).not.toContain('detached emitter line');
    expect(entries[0]?.annotations['channel']).toBe('AgentChannel');
  });
});
