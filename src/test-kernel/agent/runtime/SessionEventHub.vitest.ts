import { describe, expect, it } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import {
  SessionEventHub,
  type SessionEvent,
  type SessionFact,
} from '@agent/runtime/SessionEventHub';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import { type StorageKey, type StreamTabId } from '@shared/schemas';

import { recordSessionEvents } from '../progressTestUtils';

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

  it('routes run facts and usage from trace events onto the session hub', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const recorded = recordSessionEvents(hub, { scope: 'run' });
    const detachTrace = trace.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const todos = [
      {
        content: 'route facts',
        status: 'pending' as const,
        activeForm: 'routing facts',
      },
    ];
    const plan = { objective: 'Route every easy run fact.' };

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
      {
        streamId,
        storageKey: 'run:usage' as StorageKey,
        usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
      },
      {
        recordTranscript: false,
      },
    );
    trace.emit({ type: 'stream.chunk', id: 'ignored', text: 'x' });

    const events = [
      { type: 'updateTodos', streamId, todos },
      { type: 'updatePlan', streamId, plan },
      { type: 'addOutputFiles', streamId, filesByRound: { 1: [] } },
      { type: 'updateMissingOutputs', streamId, filesByRound: { 1: [] } },
      { type: 'updateCompileFailures', streamId, filesByRound: { 1: [] } },
      { type: 'goalPaused', streamId },
      {
        type: 'usage',
        payload: {
          streamId,
          storageKey: 'run:usage',
          usage: { inputTokens: 10, outputTokens: 5, cost: 0 },
        },
      },
      { type: 'stream.chunk', id: 'ignored', text: 'x' },
    ];

    expect(recorded.events).toMatchObject(
      events.map((event) => ({ scope: 'run', streamId, event })),
    );

    recorded.detach();
    detachTrace();
  });

  it.each([
    {
      label: 'stream descriptions',
      event: {
        type: 'updateStreamDescription',
        payload: {
          streamId,
          description: 'Checking proof outline',
        },
      },
    },
    {
      label: 'parent-stream links',
      event: {
        type: 'setParentStream',
        payload: {
          childStreamId: otherStreamId,
          parentStreamId: streamId,
        },
      },
    },
  ] satisfies ReadonlyArray<{ label: string; event: SessionFact }>)(
    'routes $label as session facts',
    ({ event }) => {
      const hub = new SessionEventHub();
      const recorded = recordSessionEvents(hub, { scope: 'session' });

      hub.emit({ scope: 'session', event });

      expect(recorded.events).toEqual([{ scope: 'session', event }]);
      recorded.detach();
    },
  );

  it('detaches session hub subscriptions cleanly', () => {
    const trace = new TraceEmitter();
    const hub = new SessionEventHub();
    const recorded = recordSessionEvents(hub, { scope: 'run' });
    const detachTrace = trace.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );

    recorded.detach();
    emitRunFact(trace, 'goalPaused', { streamId });

    expect(recorded.events).toEqual([]);
    detachTrace();
  });
});
