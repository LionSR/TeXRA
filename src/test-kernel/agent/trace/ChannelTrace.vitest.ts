import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  attachChannelSubscriber,
  createChannelTrace,
  TraceEmitter,
} from '@agent/trace';
import * as logUtils from '@logger/logUtils';
import { MESSAGE_TYPES } from '@shared/schemas';

describe('channel trace adapters', () => {
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

  it('suppresses INTERNAL-tagged lines', () => {
    const lines = captureLines();
    const trace = createChannelTrace('TestChannel');

    trace.info('internal-only line', { messageType: MESSAGE_TYPES.INTERNAL });
    trace.info('visible line');

    const output = lines.join('\n');
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
    const lines = captureLines();
    const trace = new TraceEmitter();
    const detach = attachChannelSubscriber(trace, {
      channel: 'AgentChannel',
      isAgent: true,
    });

    trace.info('visible emitter line');
    trace.info('internal emitter line', {
      messageType: MESSAGE_TYPES.INTERNAL,
    });
    detach();
    trace.info('detached emitter line');

    const output = lines.join('\n');
    expect(output).toContain('visible emitter line');
    expect(output).not.toContain('internal emitter line');
    expect(output).not.toContain('detached emitter line');
  });

  it('disposes the per-run agent sink on detach and re-creates it fresh', () => {
    const dispose = vi.fn();
    let created = 0;
    logUtils.setOutputChannelFactory(() => {
      created += 1;
      return { appendLine: vi.fn(), dispose };
    });

    const trace = new TraceEmitter();
    const detach = attachChannelSubscriber(trace, {
      channel: 'run-stream',
      isAgent: true,
    });
    expect(created).toBe(1);

    detach();
    expect(dispose).toHaveBeenCalledOnce();

    // Double detach must not dispose again: the channel entry is gone.
    detach();
    expect(dispose).toHaveBeenCalledOnce();

    // Re-attaching the same channel name mints a fresh sink, proving the
    // channel map entry was removed rather than left pointing at a disposed
    // sink.
    const reattach = attachChannelSubscriber(trace, {
      channel: 'run-stream',
      isAgent: true,
    });
    expect(created).toBe(2);
    reattach();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('stale detach after a same-name re-attach leaves the new sink alive', () => {
    const dispose = vi.fn();
    logUtils.setOutputChannelFactory(() => ({
      appendLine: vi.fn(),
      dispose,
    }));

    const trace = new TraceEmitter();
    const detachFirst = attachChannelSubscriber(trace, {
      channel: 'run-stream',
      isAgent: true,
    });
    detachFirst();
    expect(dispose).toHaveBeenCalledOnce();

    // A resumed run reuses the stream ID; the stale first detach must not
    // tear down the channel the second attachment now owns.
    attachChannelSubscriber(trace, {
      channel: 'run-stream',
      isAgent: true,
    });
    detachFirst();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('keeps the shared channel alive when a shared subscriber detaches', () => {
    const dispose = vi.fn();
    logUtils.setOutputChannelFactory(() => ({
      appendLine: vi.fn(),
      dispose,
    }));

    const trace = new TraceEmitter();
    const detach = attachChannelSubscriber(trace, {
      channel: 'Agent',
      isAgent: false,
    });

    detach();
    expect(dispose).not.toHaveBeenCalled();
  });
});
