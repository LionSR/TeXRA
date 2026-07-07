import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import {
  SessionEventHub,
  type SessionEvent,
} from '@agent/runtime/SessionEventHub';
import { attachLegacyProgressEventProjection } from '@agent/runtime/LegacyProgressEventProjection';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import { type StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:hub' as StreamTabId;
const otherStreamId = 'stream:other' as StreamTabId;

describe('SessionEventHub', () => {
  it('filters high-volume stream chunks away from typed subscribers', () => {
    const hub = new SessionEventHub();
    const seen: SessionEvent[] = [];

    hub.subscribe((event) => seen.push(event), {
      scope: 'run',
      streamId,
      types: ['domain'],
    });

    hub.emit({
      scope: 'run',
      streamId,
      event: { type: 'stream.chunk', id: 'chunk-1', text: 'a' },
    });
    hub.emit({
      scope: 'run',
      streamId: otherStreamId,
      event: { type: 'domain', key: 'other-stream', data: { ignored: true } },
    });
    hub.emit({
      scope: 'run',
      streamId,
      event: { type: 'domain', key: 'sample', data: { ok: true } },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      scope: 'run',
      event: { type: 'domain', key: 'sample' },
    });
  });

  it('asserts that a run-scope subscriber exists for the activating stream', () => {
    const hub = new SessionEventHub();

    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(streamId),
    ).toThrow(/No run-scoped session event subscribers/);

    const detachSessionOnly = hub.subscribe(() => undefined, {
      scope: 'session',
    });
    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(streamId),
    ).toThrow(/No run-scoped session event subscribers/);
    detachSessionOnly();

    const detachUnscopedRun = hub.subscribe(() => undefined, { scope: 'run' });
    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(streamId),
    ).not.toThrow();
    detachUnscopedRun();

    const detachOtherRun = hub.subscribe(() => undefined, {
      scope: 'run',
      streamId: otherStreamId,
    });
    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(streamId),
    ).toThrow(/No run-scoped session event subscribers/);
    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(otherStreamId),
    ).not.toThrow();
    detachOtherRun();

    const detachRun = hub.subscribe(() => undefined, {
      scope: 'run',
      streamId,
    });
    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(streamId),
    ).not.toThrow();
    detachRun();
    expect(() =>
      hub.assertRunSubscribersAttachedBeforeActivation(streamId),
    ).toThrow(/No run-scoped session event subscribers/);
  });

  it('projects run facts and usage from trace events to the runtime host', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const host = createRecordingHost();
    const detachTrace = trace.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const detachProjection = attachLegacyProgressEventProjection(
      hub,
      host.host,
    );
    const todos = [
      {
        content: 'route facts',
        status: 'pending' as const,
        activeForm: 'routing facts',
      },
    ];
    const plan = { objective: 'Project every easy run fact.' };

    emitRunFact(trace, 'updateTodos', { streamId, todos });
    emitRunFact(trace, 'updatePlan', { streamId, plan });
    emitRunFact(trace, 'addOutputFiles', {
      streamId,
      filesByRound: { 1: [] },
    });
    emitRunFact(trace, 'updateMissingOutputs', {
      streamId,
      filesByRound: { 1: [] },
    });
    emitRunFact(trace, 'updateCompileFailures', {
      streamId,
      filesByRound: { 1: [] },
    });
    emitRunFact(trace, 'goalPaused', { streamId });
    trace.usage(
      { inputTokens: 10, outputTokens: 5 },
      {
        data: {
          streamId,
          storageKey: 'run:usage',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
        },
        recordTranscript: false,
      },
    );
    trace.emit({ type: 'stream.chunk', id: 'ignored', text: 'x' });

    expect(host.events).toEqual([
      {
        event: 'updateTodos',
        payload: { streamId, todos },
      },
      {
        event: 'updatePlan',
        payload: { streamId, plan },
      },
      {
        event: 'addOutputFiles',
        payload: { streamId, filesByRound: { 1: [] } },
      },
      {
        event: 'updateMissingOutputs',
        payload: { streamId, filesByRound: { 1: [] } },
      },
      {
        event: 'updateCompileFailures',
        payload: { streamId, filesByRound: { 1: [] } },
      },
      {
        event: 'goalPaused',
        payload: { streamId },
      },
      {
        event: 'updateStreamUsage',
        payload: {
          streamId,
          storageKey: 'run:usage',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
        },
      },
    ]);

    detachProjection();
    detachTrace();
  });

  it('detaches legacy projection subscriptions cleanly', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const host = createRecordingHost();
    const detachTrace = trace.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const detachProjection = attachLegacyProgressEventProjection(
      hub,
      host.host,
    );

    detachProjection();
    emitRunFact(trace, 'goalPaused', { streamId });

    expect(host.events).toEqual([]);
    detachTrace();
  });
});
