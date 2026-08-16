import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import {
  activeStreamId,
  beginWorkPlanReaderRequest,
  finishWorkPlanReaderRequest,
  foregroundReader,
  patchStream,
  removeStream,
  resetCliState,
  streams,
  transientNotice,
} from '@cli/chat/tui/state/cliState';
import {
  bumpStreamArtifactRevision,
  hydrateStreamArtifacts,
  readStreamArtifacts,
  streamArtifactRevision,
  subscribeStreamArtifacts,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import {
  projectStreamArtifacts,
  type StreamArtifactReader,
} from '@controllers/session/StreamArtifactProjection';
import type {
  CompileFailure,
  OutputFileInfo,
  Plan,
  RoundIndexed,
  StorageKey,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { StreamSnapshotStore } from '@transcript';

const STREAM_A = 'workflow#a' as StreamTabId;
const STREAM_B = 'workflow#b' as StreamTabId;

function usage(
  inputTokens: number,
  outputTokens: number,
  cost: number,
): TokenUsageStats {
  return { inputTokens, outputTokens, cost };
}

function outputFile(source: string, round: number): OutputFileInfo {
  return {
    source,
    location: {
      kind: 'runStorage',
      executionId: 'abc123',
      relativePath: `r${round}/${source}`,
      absolutePath: `/tmp/texra/executions/abc123/r${round}/${source}`,
    },
    round,
    lineage: null,
    diff: null,
  };
}

/** Accumulated state a stub store serves through the read getters. */
interface StubStoreState {
  outputFiles?: RoundIndexed<OutputFileInfo>;
  missingOutputs?: RoundIndexed<string>;
  compileFailures?: RoundIndexed<CompileFailure>;
  runUsage?: ReadonlyMap<string, TokenUsageStats>;
  todos?: readonly TodoItem[];
  plan?: Plan | null;
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
    getWorkPlan: () => ({
      todos: [...(state.todos ?? [])],
      plan: state.plan ?? null,
      planSummary: null,
    }),
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

let projectionStreamCounter = 0;

/** A real store preloaded for a unique stream, then mutated with the facts.
 *  Preloading first establishes disk provenance so mutations apply eagerly
 *  instead of queueing behind the seed chain, and the unique stream id keeps
 *  sidecars from one test from leaking into the next via the shared fake
 *  platform. */
async function seededStore(
  mutate: (
    facts: ReturnType<typeof snapshotFacts>,
    streamId: StreamTabId,
  ) => void,
): Promise<{ store: StreamSnapshotStore; streamId: StreamTabId }> {
  const streamId = `workflow#proj-${++projectionStreamCounter}` as StreamTabId;
  const store = new StreamSnapshotStore();
  await store.preload([streamId]);
  const facts = snapshotFacts(store);
  mutate(facts, streamId);
  return { store, streamId };
}

async function flushSignals(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  resetCliState();
});

describe('projectStreamArtifacts', () => {
  it('sums per-run usage into cumulativeUsage', async () => {
    const { store, streamId } = await seededStore((facts, id) => {
      facts.addUsage(id, 'run-1' as StorageKey, usage(100, 20, 1));
      facts.addUsage(id, 'run-2' as StorageKey, usage(40, 10, 0.5));
    });

    expect(
      projectStreamArtifacts(store, streamId).cumulativeUsage,
    ).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      cost: 1.5,
    });
  });

  it('returns undefined cumulativeUsage when the store has no per-run usage', async () => {
    const { store, streamId } = await seededStore(() => undefined);

    expect(
      projectStreamArtifacts(store, streamId).cumulativeUsage,
    ).toBeUndefined();
  });

  it('passes through todos and plan from the work plan', async () => {
    const todos: TodoItem[] = [
      {
        content: 'Use canonical plan state',
        activeForm: 'Using canonical plan state',
        status: 'in_progress',
      },
    ];
    const plan: Plan = { objective: 'Read the canonical objective.' };
    const { store, streamId } = await seededStore((facts, id) => {
      facts.setTodos(id, todos);
      facts.setPlan(id, plan);
    });

    const projection = projectStreamArtifacts(store, streamId);
    expect(projection.todos).toEqual(todos);
    expect(projection.plan).toEqual(plan);
  });

  it('returns fresh round-indexed clones the caller cannot corrupt', async () => {
    const output = outputFile('draft.tex', 0);
    const { store, streamId } = await seededStore((facts, id) => {
      facts.addOutputFiles(id, { 0: [output] });
    });

    const first = projectStreamArtifacts(store, streamId);
    const second = projectStreamArtifacts(store, streamId);
    expect(first.outputFilesByRound).toEqual({ 0: [output] });
    expect(first.outputFilesByRound).not.toBe(second.outputFilesByRound);

    // Mutating a returned round array must not corrupt the store's accumulator.
    first.outputFilesByRound[0]?.push(outputFile('mutated.tex', 0));
    expect(projectStreamArtifacts(store, streamId).outputFilesByRound).toEqual({
      0: [output],
    });
  });
});

describe('subscribeStreamArtifacts', () => {
  it('mirrors store-accumulated cumulative usage onto the focused stream', async () => {
    const { reader, resolvePreload } = deferredReader({
      runUsage: new Map([
        ['run-1', usage(100, 20, 1)],
        ['run-2', usage(40, 10, 0.5)],
      ]),
    });

    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    resolvePreload();
    await flushSignals();

    expect(reader.preload).toHaveBeenCalledWith([STREAM_A]);
    expect(streams.get().get(STREAM_A)?.cumulativeUsage).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      cost: 1.5,
    });
    expect(streamArtifactRevision.get()).toBe(1);
    dispose();
  });

  it('keeps prior cumulative usage when the store has no per-run usage', async () => {
    const cumulativeUsage = usage(7, 3, 0.2);
    const reader = stubReader({});

    patchStream(STREAM_A, (slice) => ({ ...slice, cumulativeUsage }));
    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();

    expect(streams.get().get(STREAM_A)?.cumulativeUsage).toEqual(
      cumulativeUsage,
    );
    expect(streamArtifactRevision.get()).toBe(1);
    dispose();
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
    };

    activeStreamId.set(STREAM_A);
    const dispose = subscribeStreamArtifacts(reader);
    await flushSignals();
    activeStreamId.set(STREAM_B);
    await flushSignals();
    resolvePreloadA();
    await flushSignals();

    // The late STREAM_A read is discarded: its slice never materializes and it
    // does not repaint the projection (only STREAM_B's hydration bumped it).
    expect(streams.get().get(STREAM_A)).toBeUndefined();
    expect(streamArtifactRevision.get()).toBe(1);
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
    // Every focus invalidates the projection; the exact bump count is
    // timing-dependent (a rapid refocus can discard an in-flight read), so
    // pin only that the invalidation fired rather than a precise total.
    expect(streamArtifactRevision.get()).toBeGreaterThan(0);
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
      expect(streamArtifactRevision.get()).toBe(0);
      dispose();
      resetCliState();
    }
  });

  it('ignores late reader hydration after its captured stream is removed', async () => {
    const { reader, resolvePreload } = deferredReader({
      plan: { objective: 'Must not return after removal.' },
    });
    patchStream(STREAM_A, (slice) => ({ ...slice }));
    finishWorkPlanReaderRequest(beginWorkPlanReaderRequest(STREAM_A));

    const hydration = hydrateStreamArtifacts(reader, STREAM_A);
    removeStream(STREAM_A);
    resolvePreload();
    await hydration;

    expect(streams.get().has(STREAM_A)).toBe(false);
    expect(foregroundReader.get()).toBeUndefined();
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

  describe('readStreamArtifacts memoization', () => {
    it('returns a stable projection reference within one revision', async () => {
      const streamId = 'workflow#memo-a' as StreamTabId;
      const store = defaultSession().snapshots;
      snapshotFacts(store).addUsage(
        streamId,
        'run-1' as StorageKey,
        usage(10, 2, 0.1),
      );
      await hydrateStreamArtifacts(store, streamId);

      const first = readStreamArtifacts(streamId);
      const second = readStreamArtifacts(streamId);
      expect(first).toBe(second);
      expect(first?.cumulativeUsage).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.1,
      });
    });

    it('invalidates the memo when the artifact revision bumps', async () => {
      const streamId = 'workflow#memo-b' as StreamTabId;
      const store = defaultSession().snapshots;
      snapshotFacts(store).addUsage(
        streamId,
        'run-1' as StorageKey,
        usage(10, 2, 0.1),
      );
      await hydrateStreamArtifacts(store, streamId);
      const first = readStreamArtifacts(streamId);

      bumpStreamArtifactRevision();
      const second = readStreamArtifacts(streamId);
      expect(second).not.toBe(first);
      expect(second?.cumulativeUsage).toMatchObject({
        inputTokens: 10,
        outputTokens: 2,
        cost: 0.1,
      });
    });

    it('clears the hydration marker and memo on reset', async () => {
      const streamId = 'workflow#memo-c' as StreamTabId;
      const store = defaultSession().snapshots;
      snapshotFacts(store).addUsage(
        streamId,
        'run-1' as StorageKey,
        usage(10, 2, 0.1),
      );
      await hydrateStreamArtifacts(store, streamId);
      expect(readStreamArtifacts(streamId)).toBeDefined();

      resetCliState();
      expect(readStreamArtifacts(streamId)).toBeUndefined();
    });
  });
});
