import { afterEach, describe, expect, it, vi } from 'vitest';

import { createChannelTrace } from '@logger';
import * as logUtils from '@logger/logUtils';
import { MESSAGE_TYPES } from '@shared/schemas';
import * as config from '@utils/config';

describe('createChannelTrace', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logUtils.setOutputChannelFactory(null);
  });

  function captureLines(): string[] {
    const lines: string[] = [];
    logUtils.setOutputChannelFactory(() => ({
      appendLine(message: string) {
        lines.push(message);
      },
    }));
    return lines;
  }

  it('routes debug/info/warn/error straight to the channel sink', () => {
    const lines = captureLines();
    const trace = createChannelTrace('ChannelTraceTest');

    trace.debug('debug line');
    trace.info('info line');
    trace.warn('warn line');
    trace.error('error line');

    const output = lines.join('\n');
    expect(output).toContain('debug line');
    expect(output).toContain('info line');
    expect(output).toContain('warn line');
    expect(output).toContain('error line');
  });

  it('forwards the data payload through to the sink in debug mode', () => {
    vi.spyOn(config, 'getConfig').mockReturnValue(true);
    const lines = captureLines();
    const trace = createChannelTrace('ChannelTraceTest');

    trace.warn('payload line', { data: { foo: 'bar' } });

    const output = lines.join('\n');
    expect(output).toContain('payload line');
    expect(output).toContain('"foo"');
    expect(output).toContain('"bar"');
  });

  it('does not suppress messageType: INTERNAL lines (no callers rely on that)', () => {
    // Unlike the real per-run trace (attachChannelSubscriber), the channel
    // trace's plain log methods forward straight to the functional logger,
    // which has no `messageType` concept to filter on. This is the
    // documented, confirmed-safe behavior change from issue #7420: none of
    // the 25 module-singleton callers of `createChannelTrace` ever set
    // `messageType`, so there is nothing here to regress.
    const lines = captureLines();
    const trace = createChannelTrace('ChannelTraceTest');

    trace.info('internal-tagged line', { messageType: MESSAGE_TYPES.INTERNAL });

    expect(lines.join('\n')).toContain('internal-tagged line');
  });

  it('no-ops the rest of the AgentTrace surface instead of allocating a TraceEmitter', () => {
    const trace = createChannelTrace('ChannelTraceTest');

    // subscribe/emit never reach a real subscriber set — there isn't one.
    const unsubscribe = trace.subscribe(() => {
      throw new Error('should never be called');
    });
    expect(() =>
      trace.emit({ type: 'log', level: 'info', message: 'x' }),
    ).not.toThrow();
    expect(() => unsubscribe()).not.toThrow();

    // Stage/stream handles are safe no-ops, matching `noopTrace`.
    const stage = trace.openStage('stage');
    expect(() => stage.end()).not.toThrow();
    const stream = trace.openStream(MESSAGE_TYPES.THINKING);
    stream.append('chunk');
    expect(stream.finalize()).toBe('');
  });
});
