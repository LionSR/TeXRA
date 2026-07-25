import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  activeStreamId,
  patchStream,
  removeStream,
  resetCliState,
  streams,
} from '@cli/chat/tui/state/cliState';
import {
  subscribeStreamArtifacts,
  type StreamArtifactReader,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import { attachTuiRunFactSubscription } from '@cli/chat/tui/state/subscribeRuntimeHost';
import type { StreamSnapshot, StreamTabId } from '@shared/schemas';

const STREAM_A = 'workflow#a' as StreamTabId;
const STREAM_B = 'workflow#b' as StreamTabId;

function snapshot(
  streamId: StreamTabId,
  artifacts: Pick<
    StreamSnapshot,
    'outputFilesByRound' | 'missingOutputsByRound' | 'compileFailuresByRound'
  >,
): StreamSnapshot {
  return {
    schemaVersion: 1,
    streamId,
    todos: [],
    plan: null,
    planSummary: null,
    runUsage: {},
    conversationProgress: { toolCallCount: 0 },
    subagents: [],
    ...artifacts,
  };
}

async function flushSignals(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  resetCliState();
});

describe('subscribeStreamArtifacts', () => {
  it('preloads the focused stream and lets newer live rounds win', async () => {
    let resolveRead: (value: StreamSnapshot) => void = () => undefined;
    const readPromise = new Promise<StreamSnapshot>((resolve) => {
      resolveRead = resolve;
    });
    const reader = {
      preload: vi.fn(async () => undefined),
      read: vi.fn(() => readPromise),
    } as StreamArtifactReader;

    patchStream(STREAM_A, (slice) => slice);
    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();

    patchStream(STREAM_A, (slice) => ({
      ...slice,
      missingOutputsByRound: { 0: ['live.tex'] },
    }));
    resolveRead(
      snapshot(STREAM_A, {
        outputFilesByRound: {},
        missingOutputsByRound: { 0: ['stale.tex'], 1: ['disk.tex'] },
        compileFailuresByRound: {},
      }),
    );
    await flushSignals();

    expect(reader.preload).toHaveBeenCalledWith([STREAM_A]);
    expect(streams.get().get(STREAM_A)?.missingOutputsByRound).toEqual({
      0: ['live.tex'],
      1: ['disk.tex'],
    });
    dispose();
  });

  it('does not restore disk warnings after a live clear during hydration', async () => {
    let resolveRead: (value: StreamSnapshot) => void = () => undefined;
    const readPromise = new Promise<StreamSnapshot>((resolve) => {
      resolveRead = resolve;
    });
    const reader = {
      preload: vi.fn(async () => undefined),
      read: vi.fn(() => readPromise),
    } as StreamArtifactReader;
    const hub = new SessionEventHub();

    patchStream(STREAM_A, (slice) => ({
      ...slice,
      missingOutputsByRound: { 0: ['old-live.tex'] },
    }));
    activeStreamId.set(STREAM_A);
    const disposeArtifacts = subscribeStreamArtifacts(reader);
    const disposeFacts = attachTuiRunFactSubscription(hub);
    await flushSignals();

    hub.emit({
      scope: 'session',
      event: {
        type: 'clearMissingOutputs',
        payload: { streamId: STREAM_A },
      },
    });
    resolveRead(
      snapshot(STREAM_A, {
        outputFilesByRound: {},
        missingOutputsByRound: { 0: ['stale-disk.tex'] },
        compileFailuresByRound: {},
      }),
    );
    await flushSignals();

    expect(streams.get().get(STREAM_A)?.missingOutputsByRound).toEqual({});
    disposeFacts();
    disposeArtifacts();
  });

  it('discards a read after focus moves to another stream', async () => {
    let resolveA: (value: StreamSnapshot) => void = () => undefined;
    const readA = new Promise<StreamSnapshot>((resolve) => {
      resolveA = resolve;
    });
    const reader = {
      preload: vi.fn(async () => undefined),
      read: vi.fn((streamId: StreamTabId) =>
        streamId === STREAM_A
          ? readA
          : Promise.resolve(
              snapshot(STREAM_B, {
                outputFilesByRound: {},
                missingOutputsByRound: {},
                compileFailuresByRound: {},
              }),
            ),
      ),
    } as StreamArtifactReader;

    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();
    activeStreamId.set(STREAM_B);
    await flushSignals();
    resolveA(
      snapshot(STREAM_A, {
        outputFilesByRound: {},
        missingOutputsByRound: { 0: ['late.tex'] },
        compileFailuresByRound: {},
      }),
    );
    await flushSignals();

    expect(streams.get().get(STREAM_A)).toBeUndefined();
    expect(streams.get().get(STREAM_B)?.missingOutputsByRound).toEqual({});
    dispose();
  });

  it('cannot resurrect a removed or reset stream after a late read', async () => {
    for (const retire of [
      () => removeStream(STREAM_A),
      () => resetCliState(),
    ]) {
      let resolveRead: (value: StreamSnapshot) => void = () => undefined;
      const readPromise = new Promise<StreamSnapshot>((resolve) => {
        resolveRead = resolve;
      });
      const reader = {
        preload: vi.fn(async () => undefined),
        read: vi.fn(() => readPromise),
      } as StreamArtifactReader;

      activeStreamId.set(STREAM_A);
      const dispose = subscribeStreamArtifacts(reader);
      await flushSignals();
      retire();
      resolveRead(
        snapshot(STREAM_A, {
          outputFilesByRound: {},
          missingOutputsByRound: { 0: ['late.tex'] },
          compileFailuresByRound: {},
        }),
      );
      await flushSignals();

      expect(streams.get().has(STREAM_A)).toBe(false);
      dispose();
      resetCliState();
    }
  });
});
