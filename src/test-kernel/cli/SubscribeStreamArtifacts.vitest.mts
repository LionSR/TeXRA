import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  activeStreamId,
  patchStream,
  removeStream,
  resetCliState,
  streams,
  transientNotice,
} from '@cli/chat/tui/state/cliState';
import {
  subscribeStreamArtifacts,
  type StreamArtifactReader,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import { attachTuiRunFactSubscription } from '@cli/chat/tui/state/subscribeRuntimeHost';
import type {
  CompileFailure,
  OutputFileInfo,
  RoundIndexed,
  StreamTabId,
  TokenUsageStats,
} from '@shared/schemas';
import { StreamSnapshotStore } from '@transcript';

const STREAM_A = 'workflow#a' as StreamTabId;
const STREAM_B = 'workflow#b' as StreamTabId;

/** Accumulated state a stub store serves through the read getters. */
interface StubStoreState {
  outputFiles?: RoundIndexed<OutputFileInfo>;
  missingOutputs?: RoundIndexed<string>;
  compileFailures?: RoundIndexed<CompileFailure>;
  runUsage?: ReadonlyMap<string, TokenUsageStats>;
}

function stubReader(
  state: StubStoreState = {},
  preload: () => Promise<void> = async () => undefined,
): StreamArtifactReader {
  return {
    preload: vi.fn(preload),
    getOutputFiles: () => ({ ...(state.outputFiles ?? {}) }),
    getMissingOutputs: () => ({ ...(state.missingOutputs ?? {}) }),
    getCompileFailures: () => ({ ...(state.compileFailures ?? {}) }),
    getRunUsage: () => new Map(state.runUsage ?? []),
  };
}

function deferredReader(state: StubStoreState = {}): {
  reader: StreamArtifactReader;
  resolvePreload: () => void;
  rejectPreload: (error: unknown) => void;
} {
  let resolvePreload: () => void = () => undefined;
  let rejectPreload: (error: unknown) => void = () => undefined;
  const gate = new Promise<void>((resolve, reject) => {
    resolvePreload = resolve;
    rejectPreload = reject;
  });
  return {
    reader: stubReader(state, () => gate),
    resolvePreload,
    rejectPreload,
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
  it('copies the store-accumulated state onto the focused stream wholesale', async () => {
    const outputFile: OutputFileInfo = {
      source: 'draft.tex',
      location: {
        kind: 'runStorage',
        executionId: 'exec-a',
        relativePath: 'r1/draft.tex',
        absolutePath: '/tmp/texra/executions/exec-a/r1/draft.tex',
      },
      round: 0,
      lineage: null,
      diff: null,
    };
    const { reader, resolvePreload } = deferredReader({
      outputFiles: { 0: [outputFile] },
      missingOutputs: { 0: ['store.tex'], 1: ['disk.tex'] },
      compileFailures: {},
      runUsage: new Map([
        ['run-1', { inputTokens: 100, outputTokens: 20, cost: 1 }],
        ['run-2', { inputTokens: 40, outputTokens: 10, cost: 0.5 }],
      ]),
    });

    // A slice value diverging from the store must NOT survive hydration: the
    // store is the single accumulator (it already merged disk + live), so its
    // state replaces the slice instead of being spread underneath it.
    patchStream(STREAM_A, (slice) => ({
      ...slice,
      missingOutputsByRound: { 0: ['live.tex'] },
    }));
    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    resolvePreload();
    await flushSignals();

    expect(reader.preload).toHaveBeenCalledWith([STREAM_A]);
    expect(streams.get().get(STREAM_A)).toMatchObject({
      outputFilesByRound: { 0: [outputFile] },
      missingOutputsByRound: { 0: ['store.tex'], 1: ['disk.tex'] },
      compileFailuresByRound: {},
      cumulativeUsage: {
        inputTokens: 140,
        outputTokens: 30,
        cost: 1.5,
        cacheReadInputTokens: 0,
        cacheMissInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    dispose();
  });

  it('keeps prior cumulative usage when the store has no per-run usage', async () => {
    const cumulativeUsage = { inputTokens: 7, outputTokens: 3, cost: 0.2 };
    const reader = stubReader({});

    patchStream(STREAM_A, (slice) => ({ ...slice, cumulativeUsage }));
    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();

    expect(streams.get().get(STREAM_A)?.cumulativeUsage).toEqual(
      cumulativeUsage,
    );
    dispose();
  });

  it('does not restore stale warnings after a live clear during hydration', async () => {
    // Integration through the real accumulator: the store folds the live
    // facts (including the clear) into the same state hydration reads, so a
    // seed finishing after the clear cannot resurrect earlier warnings.
    const hub = new SessionEventHub();
    const store = new StreamSnapshotStore();
    const detachSnapshots = store.attachSessionEvents(hub);
    const detachFacts = attachTuiRunFactSubscription(hub, store);
    const preloads: Array<Promise<void>> = [];
    const reader: StreamArtifactReader = {
      preload: (streamIds) => {
        const pending = store.preload(streamIds);
        preloads.push(pending);
        return pending;
      },
      getOutputFiles: (streamId) => store.getOutputFiles(streamId),
      getMissingOutputs: (streamId) => store.getMissingOutputs(streamId),
      getCompileFailures: (streamId) => store.getCompileFailures(streamId),
      getRunUsage: (streamId) => store.getRunUsage(streamId),
    };

    try {
      hub.emit({
        scope: 'run',
        streamId: STREAM_A,
        event: {
          type: 'updateMissingOutputs',
          streamId: STREAM_A,
          filesByRound: { 0: ['old-live.tex'] },
        },
      });
      expect(streams.get().get(STREAM_A)?.missingOutputsByRound).toEqual({
        0: ['old-live.tex'],
      });

      activeStreamId.set(STREAM_A);
      const disposeArtifacts = subscribeStreamArtifacts(reader);
      hub.emit({
        scope: 'session',
        event: {
          type: 'clearMissingOutputs',
          payload: { streamId: STREAM_A },
        },
      });
      await Promise.all(preloads);
      await flushSignals();

      expect(store.getMissingOutputs(STREAM_A)).toEqual({});
      expect(streams.get().get(STREAM_A)?.missingOutputsByRound).toEqual({});
      disposeArtifacts();
    } finally {
      detachFacts();
      detachSnapshots();
      store.evictAll();
    }
  });

  it('discards a hydration after focus moves to another stream', async () => {
    let resolvePreloadA: () => void = () => undefined;
    const preloadA = new Promise<void>((resolve) => {
      resolvePreloadA = resolve;
    });
    const reader: StreamArtifactReader = {
      ...stubReader(),
      preload: vi.fn((streamIds) =>
        streamIds.includes(STREAM_A) ? preloadA : Promise.resolve(),
      ),
      getMissingOutputs: (streamId): RoundIndexed<string> =>
        streamId === STREAM_A ? { 0: ['late.tex'] } : {},
    };

    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();
    activeStreamId.set(STREAM_B);
    await flushSignals();
    resolvePreloadA();
    await flushSignals();

    expect(streams.get().get(STREAM_A)).toBeUndefined();
    expect(streams.get().get(STREAM_B)?.missingOutputsByRound).toEqual({});
    dispose();
  });

  it('starts a fresh store read each time a stream is focused', async () => {
    const reader = stubReader({ missingOutputs: { 0: ['fresh.tex'] } });

    patchStream(STREAM_A, (slice) => ({ ...slice }));
    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();
    activeStreamId.set(STREAM_B);
    await flushSignals();
    activeStreamId.set(STREAM_A);
    await flushSignals();

    expect(reader.preload).toHaveBeenCalledTimes(3);
    expect(reader.preload).toHaveBeenNthCalledWith(1, [STREAM_A]);
    expect(reader.preload).toHaveBeenNthCalledWith(2, [STREAM_B]);
    expect(reader.preload).toHaveBeenNthCalledWith(3, [STREAM_A]);
    expect(streams.get().get(STREAM_A)?.missingOutputsByRound).toEqual({
      0: ['fresh.tex'],
    });
    dispose();
  });

  it('cannot resurrect a removed or reset stream after a late read', async () => {
    for (const retire of [
      () => removeStream(STREAM_A),
      () => resetCliState(),
    ]) {
      const { reader, resolvePreload } = deferredReader({
        missingOutputs: { 0: ['late.tex'] },
      });

      activeStreamId.set(STREAM_A);
      const dispose = subscribeStreamArtifacts(reader);
      await flushSignals();
      retire();
      resolvePreload();
      await flushSignals();

      expect(streams.get().has(STREAM_A)).toBe(false);
      dispose();
      resetCliState();
    }
  });

  it('surfaces a preload failure as a transient notice instead of silence', async () => {
    const { reader, rejectPreload } = deferredReader();

    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    rejectPreload(new Error('sidecar unreadable'));
    await flushSignals();

    expect(transientNotice.get()?.text).toContain(
      'Could not load workflow artifacts: sidecar unreadable',
    );
    dispose();
  });
});
