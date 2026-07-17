import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { StreamSnapshotStore, streamDataDir } from '@transcript';
import {
  stagedStreamDataDir,
  STREAM_DATA_DIR,
} from '@transcript/streamDataPaths';
import { getExecutionStore } from '@agent/storage';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import type {
  CompileFailure,
  ExecutionId,
  OutputFileInfo,
  Plan,
  RoundIndexed,
  StorageKey,
  StreamTabId,
  TodoItem,
  TokenUsageStats,
} from '@shared/schemas';
import { RUN_DESCRIPTOR_SCHEMA_VERSION } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas/agent';
import { StorageFS } from '@utils/files';
import type { Platform } from '@platform/platform';

const tempDirs: string[] = [];

function buildSnapshotPlatform(): Promise<Platform> {
  return createTempDirPlatform('texra-snapshot-', tempDirs);
}

const STREAM = 'polish@gpt#abc123def' as StreamTabId;
const OTHER_STREAM = 'review@gpt#fed321cba' as StreamTabId;
const RUN = 'run-1' as StorageKey;
const RUN_2 = 'run-2' as StorageKey;

const TODO: TodoItem = {
  content: 'Write the introduction',
  status: 'in_progress',
  activeForm: 'Writing the introduction',
};

const PLAN: Plan = {
  objective: [
    'Draft and polish the paper',
    '',
    'Write the first draft, then revise until the reviewers sign off.',
  ].join('\n'),
};
const PLAN_SUMMARY = 'Draft and polish the paper';

function usage(input: number, output: number, cost: number): TokenUsageStats {
  return { inputTokens: input, outputTokens: output, cost };
}

function outputFile(relativePath: string, round: number): OutputFileInfo {
  return {
    source: 'document',
    location: {
      kind: 'workspace',
      absolutePath: `/workspace/${relativePath}`,
      relativePath,
    },
    round,
    lineage: null,
    diff: null,
  };
}

function compileFailure(relativePath: string, round: number): CompileFailure {
  return {
    round,
    displayName: relativePath,
    output: {
      kind: 'workspace',
      absolutePath: `/workspace/${relativePath}.pdf`,
      relativePath: `${relativePath}.pdf`,
    },
    log: {
      kind: 'workspace',
      absolutePath: `/workspace/${relativePath}.log`,
      relativePath: `${relativePath}.log`,
    },
    logRelativePath: `${relativePath}.log`,
  };
}

function toolUseTaskState(agent = 'search', model = 'deepseekproT'): TaskState {
  return TaskStateSchema.parse({
    agentConfig: {
      agent,
      model,
      agentCategory: AgentCategory.ToolUse,
    },
  });
}

function injectDuringExecutionConfigHydration(
  executionId: ExecutionId,
  inject: () => void | Promise<void>,
) {
  const originalRead = StorageFS.read.bind(StorageFS);
  const configPath = path.join(
    resolveRunStoragePath(executionId),
    'config.json',
  );
  const injected = vi.fn(inject);
  vi.spyOn(StorageFS, 'read').mockImplementation(async (target: string) => {
    const raw = await originalRead(target);
    if (target === configPath && injected.mock.calls.length === 0) {
      await injected();
    }
    return raw;
  });
  return injected;
}

describe('StreamSnapshotStore', () => {
  setupPlatform(buildSnapshotPlatform);

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  it('persists todos/plan/usage from direct mutators and reassembles them on a fresh store', async () => {
    const writer = new StreamSnapshotStore();

    writer.setTodos(STREAM, [TODO]);
    writer.setPlan(STREAM, PLAN);
    // Two deltas for the same run must accumulate, not overwrite.
    void writer.addUsage(STREAM, RUN, usage(100, 20, 0.5));
    void writer.addUsage(STREAM, RUN, usage(50, 10, 0.25));

    await writer.flush();

    // A second store reads only from disk — the resume path.
    const reader = new StreamSnapshotStore();
    const snap = await reader.read(STREAM);

    expect(snap.todos).toEqual([TODO]);
    expect(snap.plan).toEqual(PLAN);
    expect(snap.planSummary).toBe(PLAN_SUMMARY);
    expect(snap.runUsage[RUN]).toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      cost: 0.75,
    });

    // Liveness is never persisted — a resumed stream shows nothing stale.
    expect(snap.activeSubagents).toEqual([]);
    expect(snap.activeProcesses).toEqual([]);
    expect(snap.status).toBeUndefined();

    // Cross-host identity: the exact field-scoped filenames every host shares.
    const dir = streamDataDir(STREAM);
    expect(await StorageFS.exists(path.join(dir, 'workPlan.json'))).toBe(true);
    expect(await StorageFS.exists(path.join(dir, 'usageStats.json'))).toBe(
      true,
    );
  });

  it('persists durable run facts directly from session events and ignores goalPaused', async () => {
    const events = new SessionEventHub();
    const writer = new StreamSnapshotStore();
    const detach = writer.attachSessionEvents(events);
    const output = outputFile('paper.tex', 1);
    const failure = compileFailure('paper.tex', 1);
    const executionId = 'a1b2c3d4' as ExecutionId;
    const taskState = toolUseTaskState('session-search', 'kimi26T');

    await getExecutionStore(executionId).writeConfig(taskState.agentConfig);

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.config',
        streamId: STREAM,
        executionId,
        config: taskState.agentConfig,
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'updateTodos',
        streamId: STREAM,
        todos: [TODO],
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'updatePlan',
        streamId: STREAM,
        plan: PLAN,
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'addOutputFiles',
        streamId: STREAM,
        filesByRound: { 1: [output] },
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'updateMissingOutputs',
        streamId: STREAM,
        filesByRound: { 1: ['paper.pdf'] },
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'updateCompileFailures',
        streamId: STREAM,
        filesByRound: { 1: [failure] },
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'usage',
        stats: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
        data: {
          streamId: STREAM,
          storageKey: RUN,
          usage: usage(100, 20, 0.5),
        },
      },
    });
    events.emit({
      scope: 'run',
      streamId: OTHER_STREAM,
      event: {
        type: 'goalPaused',
        streamId: OTHER_STREAM,
      },
    });
    events.emit({
      scope: 'session',
      event: {
        type: 'updateStreamDescription',
        payload: {
          streamId: STREAM,
          description: 'session-search / kimi26T',
        },
      },
    });
    events.emit({
      scope: 'session',
      event: {
        type: 'setParentStream',
        payload: {
          childStreamId: STREAM,
          parentStreamId: OTHER_STREAM,
        },
      },
    });

    detach();
    await writer.flush();

    const reader = new StreamSnapshotStore();
    await reader.load([STREAM]);
    const snap = await reader.read(STREAM);
    expect(snap.todos).toEqual([TODO]);
    expect(snap.plan).toEqual(PLAN);
    expect(snap.outputFilesByRound).toEqual({ '1': [output] });
    expect(snap.missingOutputsByRound).toEqual({ '1': ['paper.pdf'] });
    expect(snap.compileFailuresByRound).toEqual({ '1': [failure] });
    expect(snap.runUsage[RUN]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });
    expect(snap.executionId).toBe(executionId);
    expect(snap.description).toBe('session-search / kimi26T');
    expect(snap.parentStreamId).toBe(OTHER_STREAM);
    expect(reader.getTaskState(STREAM)).toEqual(taskState);
    expect(reader.getRunDescriptor(STREAM)).toMatchObject({
      streamId: STREAM,
      executionId,
      agent: 'session-search',
      category: AgentCategory.ToolUse,
    });

    const goalPausedOnly = await new StreamSnapshotStore().read(OTHER_STREAM);
    expect(goalPausedOnly.todos).toEqual([]);
    expect(goalPausedOnly.plan).toBeNull();
    expect(goalPausedOnly.runUsage).toEqual({});
  });

  it('returns an empty (valid) snapshot for a stream with no sidecar', async () => {
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.streamId).toBe(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
    expect(snap.runUsage).toEqual({});
  });

  it('migrates the legacy nested {runId:{round}} shape to flat ONCE at the load entry', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'missingOutputs.json'),
      JSON.stringify({ 'run-1': { '0': ['a.tex'], '1': ['b.tex'] } }),
    );

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    await store.flush();

    // The on-disk file is now FLAT — migrated once at the load entry, never
    // re-resolved on subsequent reads.
    const raw = await StorageFS.readJson(path.join(dir, 'missingOutputs.json'));
    expect(raw).toEqual({ '0': ['a.tex'], '1': ['b.tex'] });
    // …and a fresh read sees the flattened data.
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.missingOutputsByRound).toEqual({
      '0': ['a.tex'],
      '1': ['b.tex'],
    });
  });

  it('seeds existing disk data before an unloaded usage mutation, so it is not erased', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    // A prior session persisted usage for run-1.
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ 'run-1': usage(100, 20, 0.5) }),
    );

    // A fresh store (NOT load()ed) handles a delta for a NEW run.
    const store = new StreamSnapshotStore();
    void store.addUsage(STREAM, 'run-2' as StorageKey, usage(50, 10, 0.25));
    await store.flush();

    // run-1 (prior) survives — the unseeded write did not clobber it.
    const raw = await StorageFS.readJson(path.join(dir, 'usageStats.json'));
    expect(raw).toMatchObject({
      'run-1': { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      'run-2': { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('preserves an unparseable persisted usage entry across a save instead of deleting it', async () => {
    // Regression test for #7464: a run entry that fails to parse (e.g. a
    // corrupted or future-shaped value) must be logged loudly and carried
    // through unchanged, rather than silently zeroed and then permanently
    // deleted from disk by the next writeUsage().
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({
        [RUN]: usage(100, 20, 0.5),
        'run-corrupt': 'this-is-not-a-usage-object',
      }),
    );

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new StreamSnapshotStore();
    // Force a seed + a write for an unrelated run so writeUsage() actually
    // rewrites usageStats.json from the in-memory accumulators.
    const pending = store.addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    await Promise.resolve(pending);
    await store.flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    const raw = await StorageFS.readJson(path.join(dir, 'usageStats.json'));
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
      'run-corrupt': 'this-is-not-a-usage-object',
    });

    // The corrupted entry is preserved on disk for round-tripping but is
    // never surfaced through the typed in-memory usage view.
    expect(store.getRunUsage(STREAM).has('run-corrupt')).toBe(false);
  });

  it('resolves pre-seed usage after merging existing disk usage', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ [RUN]: usage(100, 20, 0.5) }),
    );

    const store = new StreamSnapshotStore();
    const pending = store.addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    expect(store.getRunUsage(STREAM).get(RUN_2)).toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await expect(Promise.resolve(pending)).resolves.toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'usageStats.json'));
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('returns pre-seed usage only after a partial preload baseline is merged', async () => {
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ [RUN]: usage(100, 20, 0.5) }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    const pending = store.addUsage(OTHER_STREAM, RUN_2, usage(50, 10, 0.25));
    expect(store.getRunUsage(OTHER_STREAM).get(RUN_2)).toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await expect(Promise.resolve(pending)).resolves.toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'usageStats.json'));
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('includes the disk baseline in a pre-seed usage result for the same run', async () => {
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ [RUN]: usage(100, 20, 0.5) }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    const pending = store.addUsage(OTHER_STREAM, RUN, usage(50, 10, 0.25));
    expect(store.getRunUsage(OTHER_STREAM).get(RUN)).toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await expect(Promise.resolve(pending)).resolves.toMatchObject({
      inputTokens: 150,
      outputTokens: 30,
      cost: 0.75,
    });
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'usageStats.json'));
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 150, outputTokens: 30, cost: 0.75 },
    });
  });

  it('returns output files immediately for streams outside a partial preload without erasing disk outputs', async () => {
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    const prior = outputFile('prior.tex', 0);
    const next = outputFile('next.tex', 1);
    await StorageFS.write(
      path.join(dir, 'outputFiles.json'),
      JSON.stringify({ '0': [prior] }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.addOutputFiles(OTHER_STREAM, { 1: [next] });
    const returned = store.getOutputFiles(OTHER_STREAM);
    returned[1]?.push(outputFile('injected.tex', 1));
    expect(store.getOutputFiles(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'outputFiles.json'));
    expect(raw).toMatchObject({
      '0': [prior],
      '1': [next],
    });
  });

  it('keeps output overlays when flattening legacy output files after preload', async () => {
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    const prior = outputFile('prior.tex', 0);
    const next = outputFile('next.tex', 1);
    await StorageFS.write(
      path.join(dir, 'outputFiles.json'),
      JSON.stringify({ [RUN]: { '0': [prior] } }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.addOutputFiles(OTHER_STREAM, { 1: [next] });
    expect(store.getOutputFiles(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'outputFiles.json'));
    expect(raw).toEqual({
      '0': [prior],
      '1': [next],
    });
  });

  it('returns missing outputs immediately for streams outside a partial preload without erasing disk markers', async () => {
    // Same race as the output-files case above, replayed for
    // updateMissingOutputs: a stream outside the preloaded set is still
    // unseeded when the mutation lands, so the seed's disk read is racing
    // the caller's read of its own write. Regression for the "half-fixed"
    // eager-apply overlay gap (missingOutputs/compileFailures lacked the
    // guarantee addOutputFiles/addUsage already had).
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'missingOutputs.json'),
      JSON.stringify({ '0': ['prior.tex'] }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.updateMissingOutputs(OTHER_STREAM, { 1: ['next.tex'] });
    // Fails pre-fix: the plain mutate() path defers the whole apply behind
    // the in-flight seed, so this synchronous read-back still sees nothing.
    expect(store.getMissingOutputs(OTHER_STREAM)[1]).toEqual(['next.tex']);
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'missingOutputs.json'));
    expect(raw).toMatchObject({
      '0': ['prior.tex'],
      '1': ['next.tex'],
    });
  });

  it('rejects malformed missing-output patches before mutating memory or persisted state', async () => {
    const dir = streamDataDir(STREAM);
    const store = new StreamSnapshotStore();
    await store.load([STREAM]);

    store.updateMissingOutputs(STREAM, { 0: ['prior.tex'] });
    await store.flush();

    const malformedPatch = {
      0: ['replacement.tex'],
      1: ['invalid.tex', 42],
    } as unknown as RoundIndexed<string>;
    expect(() => store.updateMissingOutputs(STREAM, malformedPatch)).toThrow();

    expect(store.getMissingOutputs(STREAM)).toEqual({ 0: ['prior.tex'] });
    await store.flush();
    expect(
      await StorageFS.readJson(path.join(dir, 'missingOutputs.json')),
    ).toEqual({ '0': ['prior.tex'] });

    store.updateMissingOutputs(STREAM, { 1: ['next.tex'] });
    expect(store.getMissingOutputs(STREAM)).toEqual({
      0: ['prior.tex'],
      1: ['next.tex'],
    });
    await store.flush();
    expect(
      await StorageFS.readJson(path.join(dir, 'missingOutputs.json')),
    ).toEqual({
      '0': ['prior.tex'],
      '1': ['next.tex'],
    });
  });

  it('replays clearMissingOutputs before a later updateMissingOutputs on an unseeded stream', async () => {
    // clearMissingOutputs must not stay on the plain deferred mutate() path
    // while updateMissingOutputs eagerly overlays: on an unseeded stream that
    // ordering let the seed's overlay replay (update) land, then the clear
    // (queued behind the same seed) run afterward and wipe it out regardless
    // of call order. Here the clear fires first, so the later update must
    // survive.
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'missingOutputs.json'),
      JSON.stringify({ '0': ['stale.tex'] }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.clearMissingOutputs(OTHER_STREAM);
    store.updateMissingOutputs(OTHER_STREAM, { 1: ['next.tex'] });
    expect(store.getMissingOutputs(OTHER_STREAM)).toEqual({ 1: ['next.tex'] });
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'missingOutputs.json'));
    expect(raw).toEqual({ '1': ['next.tex'] });
  });

  it('replays a later clearMissingOutputs over an earlier updateMissingOutputs on an unseeded stream', async () => {
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'missingOutputs.json'),
      JSON.stringify({ '0': ['stale.tex'] }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.updateMissingOutputs(OTHER_STREAM, { 1: ['next.tex'] });
    store.clearMissingOutputs(OTHER_STREAM);
    expect(store.getMissingOutputs(OTHER_STREAM)).toEqual({});
    await store.flush();

    const raw = await StorageFS.readJson(path.join(dir, 'missingOutputs.json'));
    expect(raw).toEqual({});
  });

  it('returns compile failures immediately for streams outside a partial preload without erasing disk markers', async () => {
    const dir = streamDataDir(OTHER_STREAM);
    await StorageFS.ensureDir(dir);
    const prior = compileFailure('prior.tex', 0);
    const next = compileFailure('next.tex', 1);
    await StorageFS.write(
      path.join(dir, 'compileFailures.json'),
      JSON.stringify({ '0': [prior] }),
    );

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.updateCompileFailures(OTHER_STREAM, { 1: [next] });
    // Fails pre-fix for the same reason as the missing-outputs case above.
    expect(store.getCompileFailures(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await StorageFS.readJson(
      path.join(dir, 'compileFailures.json'),
    );
    expect(raw).toMatchObject({
      '0': [prior],
      '1': [next],
    });
  });

  it('makes task state readable immediately while preserving later seeded sidecars', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ [RUN]: usage(100, 20, 0.5) }),
    );

    const store = new StreamSnapshotStore();
    const taskState = toolUseTaskState();
    const executionId = 'abc123' as ExecutionId;

    store.setTaskState(STREAM, taskState, executionId);
    expect(store.getTaskState(STREAM)).toEqual(taskState);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
    await expect(
      Promise.resolve(store.addUsage(STREAM, RUN_2, usage(50, 10, 0.25))),
    ).resolves.toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await store.flush();

    expect(store.getTaskState(STREAM)).toEqual(taskState);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
    const raw = await StorageFS.readJson(path.join(dir, 'usageStats.json'));
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('forces the current meta schema version over stale cached meta', async () => {
    await installPlatform();
    const store = new StreamSnapshotStore();
    await store.load([]);

    // Consolidated per-stream state (#8124): every field lives on one record
    // keyed by stream id, so priming a stale in-memory meta means seeding
    // just the `meta` field of that record rather than a standalone map.
    const internals = store as unknown as {
      records: Map<
        StreamTabId,
        { meta?: { schemaVersion: number; description?: string } }
      >;
    };
    internals.records.set(STREAM, { meta: { schemaVersion: 0 } });

    store.setDescription(STREAM, 'Updated session');
    await store.flush();

    expect(internals.records.get(STREAM)?.meta).toMatchObject({
      schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
      description: 'Updated session',
    });
  });

  it('preserves legacy meta taskState when unrelated meta patches are written', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const taskState = toolUseTaskState('legacy-search');
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
        taskState,
      }),
    );

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    store.setDescription(STREAM, 'Prior session');
    await store.flush();

    const raw = (await StorageFS.readJson(path.join(dir, 'meta.json'))) as {
      schemaVersion?: unknown;
      taskState?: unknown;
      description?: unknown;
    };
    expect(raw.schemaVersion).toBe(RUN_DESCRIPTOR_SCHEMA_VERSION);
    expect(raw.taskState).toEqual(taskState);
    expect(raw.description).toBe('Prior session');
  });

  it('falls back to legacy taskState when an execution config is unreadable', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const executionId = 'abc123' as ExecutionId;
    const taskState = toolUseTaskState('legacy-search');
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
        executionId,
        taskState,
      }),
    );
    await StorageFS.ensureDir(resolveRunStoragePath(executionId));
    await StorageFS.write(
      path.join(resolveRunStoragePath(executionId), 'config.json'),
      '{',
    );

    const store = new StreamSnapshotStore();
    await expect(store.load([STREAM])).resolves.toBeUndefined();

    expect(store.getTaskState(STREAM)).toEqual(taskState);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
  });

  it('keeps a runtime run-config update that arrives during async hydration', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const oldExecutionId = 'abc123' as ExecutionId;
    const newExecutionId = 'def456' as ExecutionId;
    const oldTaskState = toolUseTaskState('old-search');
    const newTaskState = toolUseTaskState('new-search');
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
        executionId: oldExecutionId,
      }),
    );
    await getExecutionStore(oldExecutionId).writeConfig(
      oldTaskState.agentConfig,
    );

    const store = new StreamSnapshotStore();
    const wasRuntimeUpdateInjected = injectDuringExecutionConfigHydration(
      oldExecutionId,
      () => store.setTaskState(STREAM, newTaskState, newExecutionId),
    );

    await store.load([STREAM]);
    expect(wasRuntimeUpdateInjected).toHaveBeenCalledOnce();
    expect(store.getTaskState(STREAM)).toEqual(newTaskState);
    expect(store.getExecutionId(STREAM)).toBe(newExecutionId);

    await store.flush();
    const raw = (await StorageFS.readJson(path.join(dir, 'meta.json'))) as {
      executionId?: unknown;
      runDescriptor?: { executionId?: unknown; agent?: unknown };
    };
    expect(raw.executionId).toBe(newExecutionId);
    expect(raw.runDescriptor).toMatchObject({
      executionId: newExecutionId,
      agent: 'new-search',
    });
  });

  it('persists a late reset and round patch that arrive during async hydration', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const executionId = 'c0ffee' as ExecutionId;
    await StorageFS.ensureDir(dir);
    await Promise.all([
      StorageFS.write(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
          executionId,
        }),
      ),
      StorageFS.write(
        path.join(dir, 'missingOutputs.json'),
        JSON.stringify({ '0': ['stale.tex'] }),
      ),
      getExecutionStore(executionId).writeConfig(
        toolUseTaskState().agentConfig,
      ),
    ]);

    const store = new StreamSnapshotStore();
    const wereLateOverlaysInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => {
        store.clearMissingOutputs(STREAM);
        store.updateMissingOutputs(STREAM, { 1: ['late.tex'] });
        void store.addUsage(STREAM, RUN, usage(10, 2, 0.1));
      },
    );

    await store.load([STREAM]);
    expect(wereLateOverlaysInjected).toHaveBeenCalledOnce();
    expect(store.getMissingOutputs(STREAM)).toEqual({ 1: ['late.tex'] });
    expect(store.getRunUsage(STREAM).get(RUN)).toMatchObject(usage(10, 2, 0.1));
    await store.flush();

    const [missingOutputs, usageStats] = await Promise.all([
      StorageFS.readJson(path.join(dir, 'missingOutputs.json')),
      StorageFS.readJson(path.join(dir, 'usageStats.json')),
    ]);
    expect(missingOutputs).toEqual({ '1': ['late.tex'] });
    expect(usageStats).toMatchObject({ [RUN]: usage(10, 2, 0.1) });
  });

  it('does not recreate sidecars when a stream is deleted during hydration', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const executionId = 'deadbeef' as ExecutionId;
    await StorageFS.ensureDir(dir);
    await Promise.all([
      StorageFS.write(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
          executionId,
          activeRunId: RUN,
        }),
      ),
      StorageFS.write(
        path.join(dir, 'missingOutputs.json'),
        JSON.stringify({ [RUN]: { '0': ['legacy.tex'] } }),
      ),
      getExecutionStore(executionId).writeConfig(
        toolUseTaskState().agentConfig,
      ),
    ]);

    const store = new StreamSnapshotStore();
    let deletion: Promise<void> | undefined;
    const wasDeletedDuringHydration = injectDuringExecutionConfigHydration(
      executionId,
      () => {
        deletion = store.deleteStream(STREAM);
      },
    );

    await store.load([STREAM]);
    if (!deletion) throw new Error('Deletion was not injected');
    await deletion;
    await store.flush();

    expect(wasDeletedDuringHydration).toHaveBeenCalledOnce();
    expect(await StorageFS.exists(dir)).toBe(false);
  });

  it('load refreshes already-seeded streams from disk instead of keeping stale memory', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ [RUN]: usage(100, 20, 0.5) }),
    );

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunUsage(STREAM).get(RUN)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });

    await StorageFS.write(
      path.join(dir, 'usageStats.json'),
      JSON.stringify({ [RUN]: usage(3, 4, 0.01) }),
    );
    await store.load([STREAM]);

    expect(store.getRunUsage(STREAM).get(RUN)).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      cost: 0.01,
    });
  });

  it('treats streams created after load as new so direct mutators stay synchronous', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);

    store.setTodos(STREAM, [TODO]);
    store.setPlan(STREAM, PLAN);

    expect(store.getWorkPlan(STREAM)).toEqual({
      todos: [TODO],
      plan: PLAN,
      planSummary: PLAN_SUMMARY,
    });
    await store.flush();
  });

  it('deleteStream cancels queued writes before removing the sidecar directory', async () => {
    const dir = streamDataDir(STREAM);
    const store = new StreamSnapshotStore();
    await store.load([]);

    store.addUsage(STREAM, RUN, usage(1, 2, 0.03));
    await store.deleteStream(STREAM);

    expect(await StorageFS.exists(dir)).toBe(false);
  });

  it('keeps the complete snapshot when atomic staging fails', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setTodos(STREAM, [TODO]);
    store.setPlan(STREAM, PLAN);
    await store.flush();
    const deletionError = new Error('stream data directory is locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(deletionError);

    await expect(store.deleteStream(STREAM)).rejects.toBe(deletionError);

    expect(store.getWorkPlan(STREAM)).toEqual({
      todos: [TODO],
      plan: PLAN,
      planSummary: PLAN_SUMMARY,
    });

    const reloaded = new StreamSnapshotStore();
    await reloaded.load([STREAM]);
    expect(reloaded.getWorkPlan(STREAM)).toMatchObject({
      todos: [TODO],
      plan: PLAN,
      planSummary: PLAN_SUMMARY,
    });

    renameSpy.mockRestore();
    await store.deleteStream(STREAM);
  });

  it('recovers a crash-interrupted staged deletion before hydration', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setTodos(STREAM, [TODO]);
    store.setPlan(STREAM, PLAN);
    await store.flush();

    await store.stageDeleteStream(STREAM);
    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);

    const recovered = new StreamSnapshotStore();
    await expect(
      recovered.reconcileStagedDeletions(new Set([STREAM])),
    ).resolves.toEqual({
      restored: [STREAM],
      pendingCleanup: [],
      discarded: [],
    });
    await recovered.load([STREAM]);

    expect(recovered.getWorkPlan(STREAM)).toMatchObject({
      todos: [TODO],
      plan: PLAN,
      planSummary: PLAN_SUMMARY,
    });
    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(true);
    await recovered.deleteStream(STREAM);
  });

  it('buffers sidecar writes until a staged deletion rolls back', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    await store.flush();

    const deletion = await store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, null);
    await store.flush();

    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);

    await deletion.rollback();
    await store.flush();

    const reloaded = new StreamSnapshotStore();
    await reloaded.load([STREAM]);
    expect(reloaded.getWorkPlan(STREAM)).toMatchObject({
      todos: [],
      plan: null,
      planSummary: null,
    });
  });

  it('serializes overlapping staged deletions for one stream', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    await store.flush();

    const firstDeletion = await store.stageDeleteStream(STREAM);
    let secondStarted = false;
    const secondDeletion = store.stageDeleteStream(STREAM).then((deletion) => {
      secondStarted = true;
      return deletion;
    });
    await Promise.resolve();

    expect(secondStarted).toBe(false);

    await firstDeletion.rollback();
    const deletion = await secondDeletion;
    expect(secondStarted).toBe(true);
    await deletion.commit();
    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);
  });

  it('allows retry after staged rollback fails', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    await store.flush();
    const deletion = await store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, null);
    await store.flush();
    const rollbackError = new Error('snapshot directory is still locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(rollbackError);

    await expect(deletion.rollback()).rejects.toBe(rollbackError);

    renameSpy.mockRestore();
    const retry = await store.stageDeleteStream(STREAM);
    await retry.rollback();
    await store.flush();

    const reloaded = new StreamSnapshotStore();
    await reloaded.load([STREAM]);
    expect(reloaded.getWorkPlan(STREAM).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('restores committed residue for complete orphan cleanup', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    await store.flush();
    await store.stageDeleteStream(STREAM);

    const recovered = new StreamSnapshotStore();
    await expect(
      recovered.reconcileStagedDeletions(new Set()),
    ).resolves.toEqual({
      restored: [],
      pendingCleanup: [STREAM],
      discarded: [],
    });

    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(true);
    expect(await StorageFS.exists(stagedStreamDataDir(STREAM))).toBe(false);
  });

  it('does not treat storage errors as an absent snapshot directory', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    await store.flush();
    const liveDir = streamDataDir(STREAM);
    const stat = StorageFS.stat.bind(StorageFS);
    const statError = Object.assign(new Error('snapshot directory is locked'), {
      code: 'EACCES',
    });
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockImplementation(async (target) => {
        if (target === liveDir) throw statError;
        return stat(target);
      });

    await expect(store.stageDeleteStream(STREAM)).rejects.toBe(statError);

    expect(await StorageFS.exists(liveDir)).toBe(true);
    statSpy.mockRestore();
    await store.deleteStream(STREAM);
  });

  it('waits for active hydration before staging deletion', async () => {
    await installPlatform();
    const executionId = 'feedface' as ExecutionId;
    const writer = new StreamSnapshotStore();
    await writer.load([]);
    writer.setTaskState(STREAM, toolUseTaskState(), executionId);
    writer.setPlan(STREAM, PLAN);
    await writer.flush();
    await getExecutionStore(executionId).writeConfig(
      toolUseTaskState().agentConfig,
    );

    const store = new StreamSnapshotStore();
    const deletionError = new Error('stream data directory is locked');
    vi.spyOn(StorageFS, 'rename').mockRejectedValueOnce(deletionError);
    let deletion: Promise<void> | undefined;
    const wasDeleteInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => {
        deletion = store.deleteStream(STREAM);
        void deletion.catch(() => undefined);
      },
    );

    await store.load([STREAM]);
    if (!deletion) throw new Error('Deletion was not injected');
    await expect(deletion).rejects.toBe(deletionError);
    await store.flush();

    expect(wasDeleteInjected).toHaveBeenCalledOnce();
    expect(store.getWorkPlan(STREAM).plan).toEqual(PLAN);
    store.setTodos(STREAM, [TODO]);
    expect(store.getWorkPlan(STREAM).todos).toEqual([TODO]);
    await store.flush();

    const reloaded = new StreamSnapshotStore();
    await reloaded.load([STREAM]);
    expect(reloaded.getWorkPlan(STREAM).todos).toEqual([TODO]);
  });

  it('does not resurrect a deleted sidecar dir when deleteStream lands during hydration', async () => {
    // Regression for #8226: applyStreamData awaits execution-config hydration
    // mid-seed. If the stream is deleted during that await, the continuation
    // must not re-resolve a record for the evicted stream and flush merged
    // sidecars — pre-fix, the legacy-shaped file below queued an unconditional
    // rewrite that recreated `streamData/{id}/` after deleteDir() removed it.
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const executionId = 'dead01' as ExecutionId;
    await StorageFS.ensureDir(dir);
    await Promise.all([
      StorageFS.write(
        path.join(dir, 'meta.json'),
        JSON.stringify({
          schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
          executionId,
        }),
      ),
      // Legacy nested shape → `missingOutputs` lands in `data.legacyKeys`,
      // arming the merged-sidecar rewrite regardless of overlays.
      StorageFS.write(
        path.join(dir, 'missingOutputs.json'),
        JSON.stringify({ 'run-1': { '0': ['stale.tex'] } }),
      ),
      getExecutionStore(executionId).writeConfig(
        toolUseTaskState().agentConfig,
      ),
    ]);

    const store = new StreamSnapshotStore();
    let deletion: Promise<void> | undefined;
    const wasDeleteInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => {
        deletion = store.deleteStream(STREAM);
      },
    );

    await store.load([STREAM]);
    if (!deletion) throw new Error('Deletion was not injected');
    await deletion;
    expect(wasDeleteInjected).toHaveBeenCalledOnce();
    await store.flush();

    expect(await StorageFS.exists(dir)).toBe(false);
    expect(await store.listPersistedStreams()).not.toContain(STREAM);
  });

  it('serializes same-key writes so a slow first write finishes before a queued second write starts', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);

    const order: string[] = [];
    let releaseFirstWrite: () => void = () => {};
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    const writeAtomicSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockImplementation(async () => {
        writeCount += 1;
        if (writeCount === 1) {
          order.push('first-start');
          await firstWriteGate;
          order.push('first-end');
        } else {
          order.push('second-start');
        }
      });

    // Both land on the same `${stream}::workPlan` write lock.
    store.setTodos(STREAM, [TODO]);
    store.setPlan(STREAM, PLAN);

    // Let the first queued write actually begin before releasing it, so the
    // assertion below reflects genuine serialization, not incidental timing.
    await vi.waitFor(() => {
      expect(order).toEqual(['first-start']);
    });

    releaseFirstWrite();
    await store.flush();

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
    writeAtomicSpy.mockRestore();
  });

  it('deleteStream refuses reserved stream ids before sidecar directory removal', async () => {
    const sentinel = path.join(STREAM_DATA_DIR, 'sentinel.json');
    await StorageFS.ensureDir(STREAM_DATA_DIR);
    await StorageFS.write(sentinel, '{}');

    const store = new StreamSnapshotStore();
    await store.deleteStream('' as StreamTabId);
    await store.deleteStream('.' as StreamTabId);
    await store.deleteStream('..' as StreamTabId);

    expect(await StorageFS.exists(sentinel)).toBe(true);
  });

  it('returns a frozen shared empty work plan default', async () => {
    const empty = new StreamSnapshotStore().getWorkPlan(STREAM);
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.todos)).toBe(true);
  });

  it('degrades gracefully when workPlan.json is valid JSON but the wrong shape', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    // Corrupt-but-parseable payload must NOT throw and abort read()/resume.
    await StorageFS.write(
      path.join(dir, 'workPlan.json'),
      JSON.stringify({ todos: 'not-an-array', plan: 42 }),
    );
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
  });

  it('ignores a workPlan.json stamped with a newer schemaVersion (forward-compat gate)', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    // A file from a FUTURE schema must be read as empty, not have its unknown
    // shape consumed as v1 (the single forward-compat gate).
    await StorageFS.write(
      path.join(dir, 'workPlan.json'),
      JSON.stringify({
        schemaVersion: 999,
        todos: [TODO],
        plan: PLAN,
        planSummary: PLAN_SUMMARY,
      }),
    );
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
  });

  it('drops a malformed executionId at the read entry without aborting the snapshot', async () => {
    const dir = streamDataDir(STREAM);
    await StorageFS.ensureDir(dir);
    // A legacy/corrupt executionId would trip the strict ExecutionIdSchema in
    // assembleSnapshot; validating at the read entry drops just the bad pointer
    // so the rest of meta (description) still surfaces and resume never throws.
    await StorageFS.write(
      path.join(dir, 'meta.json'),
      JSON.stringify({
        executionId: 'not-hex!!',
        description: 'Prior session',
      }),
    );
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.executionId).toBeUndefined();
    expect(snap.description).toBe('Prior session');
  });

  // `readLegacyInstruction` reads a pre-#3061 tab's original prompt from its
  // archival runInstructions.json/legacyInstructions.json file; still needed
  // until the persisted-run retention window guarding those tabs expires.
  describe('readLegacyInstruction', () => {
    it('returns null when no archival file exists', async () => {
      const legacy = await new StreamSnapshotStore().readLegacyInstruction(
        STREAM,
      );
      expect(legacy).toBeNull();
    });

    it('reads the canonical legacyInstructions.json', async () => {
      const dir = streamDataDir(STREAM);
      await StorageFS.ensureDir(dir);
      await StorageFS.write(
        path.join(dir, 'legacyInstructions.json'),
        JSON.stringify({
          'run-1': { text: 'Polish the introduction', timestamp: 100 },
        }),
      );

      const legacy = await new StreamSnapshotStore().readLegacyInstruction(
        STREAM,
      );
      expect(legacy?.text).toBe('Polish the introduction');
    });

    it('falls back to the older runInstructions.json key, unmodified', async () => {
      const dir = streamDataDir(STREAM);
      await StorageFS.ensureDir(dir);
      await StorageFS.write(
        path.join(dir, 'runInstructions.json'),
        JSON.stringify({ 'run-1': { text: 'Rewrite the abstract' } }),
      );

      const legacy = await new StreamSnapshotStore().readLegacyInstruction(
        STREAM,
      );
      expect(legacy?.text).toBe('Rewrite the abstract');
      // Read-only: no migration/rename happens on disk.
      expect(
        await StorageFS.exists(path.join(dir, 'runInstructions.json')),
      ).toBe(true);
      expect(
        await StorageFS.exists(path.join(dir, 'legacyInstructions.json')),
      ).toBe(false);
    });

    it('prefers meta.activeRunId when multiple archived runs exist', async () => {
      const dir = streamDataDir(STREAM);
      await StorageFS.ensureDir(dir);
      await StorageFS.write(
        path.join(dir, 'legacyInstructions.json'),
        JSON.stringify({
          older: { text: 'older instruction', timestamp: 100 },
          active: { text: 'active instruction', timestamp: 50 },
        }),
      );
      await StorageFS.write(
        path.join(dir, 'meta.json'),
        JSON.stringify({ activeRunId: 'active' }),
      );

      const legacy = await new StreamSnapshotStore().readLegacyInstruction(
        STREAM,
      );
      expect(legacy?.text).toBe('active instruction');
    });
  });
});
