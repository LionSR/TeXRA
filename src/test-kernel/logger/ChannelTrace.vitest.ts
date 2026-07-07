import { afterEach, describe, expect, it } from 'vitest';

import { createChannelTrace } from '@logger';
import * as logUtils from '@logger/logUtils';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('createChannelTrace', () => {
  afterEach(() => {
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

  it('routes debug/info/warn/error through the functional per-channel sink', () => {
    const lines = captureLines();
    const trace = createChannelTrace('TestChannel');

    trace.debug('a debug line');
    trace.info('an info line');
    trace.warn('a warn line');
    trace.error('an error line');

    const output = lines.join('\n');
    expect(output).toContain('a debug line');
    expect(output).toContain('an info line');
    expect(output).toContain('a warn line');
    expect(output).toContain('an error line');
  });

  it('suppresses INTERNAL-tagged lines, matching the TraceEmitter + attachChannelSubscriber path', () => {
    const lines = captureLines();
    const trace = createChannelTrace('TestChannel');

    trace.info('internal-only line', { messageType: MESSAGE_TYPES.INTERNAL });
    trace.info('visible line');

    const output = lines.join('\n');
    expect(output).not.toContain('internal-only line');
    expect(output).toContain('visible line');
  });

  it('is inert on non-log AgentTrace members (no subscribers, no stage/stream side effects)', () => {
    const trace = createChannelTrace('TestChannel');

    // Subscribing and emitting must not throw and must not somehow route
    // back through the functional logger (only debug/info/warn/error do).
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
});
