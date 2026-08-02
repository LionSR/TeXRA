import * as path from 'node:path';

import pDefer from 'p-defer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { TaskStateSchema, type TaskState } from '@agent/core/state/TaskState';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import * as logUtils from '@logger/logUtils';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  RUN_DESCRIPTOR_SCHEMA_VERSION,
  buildRunDescriptor,
} from '@shared/schemas';
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
import { AgentCategory } from '@shared/schemas/agent';
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { StreamSnapshotStore, streamDataDir } from '@transcript';
import {
  stagedStreamDataDir,
  STREAM_DATA_DIR,
  STREAM_DATA_DELETION_DIR,
} from '@transcript/streamDataPaths';
import { StorageFS } from '@utils/files';

const tempDirs: string[] = [];

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

function toolUseConfig(agent = 'search', model = 'deepseekproT'): AgentConfig {
  return AgentConfigSchema.parse({
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
  });
}

/** Legacy `meta.taskState` payload, written only by the disk-read shim tests. */
function toolUseTaskState(agent = 'search', model = 'deepseekproT'): TaskState {
  return TaskStateSchema.parse({ agentConfig: toolUseConfig(agent, model) });
}

type StagedDeletion = Awaited<
  ReturnType<StreamSnapshotStore['stageDeleteStream']>
>;
type WorkPlan = ReturnType<StreamSnapshotStore['getWorkPlan']>;

async function writeStreamFile(
  stream: StreamTabId,
  name: string,
  contents: unknown,
): Promise<void> {
  const dir = streamDataDir(stream);
  await StorageFS.ensureDir(dir);
  await StorageFS.write(path.join(dir, name), JSON.stringify(contents));
}

/** Persist a stream's meta sidecar stamped with the current schema version. */
function writeMetaFile(
  stream: StreamTabId,
  meta: Record<string, unknown>,
): Promise<void> {
  return writeStreamFile(stream, 'meta.json', {
    schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
    ...meta,
  });
}

function readStreamFile(stream: StreamTabId, name: string): Promise<unknown> {
  return StorageFS.readJson(path.join(streamDataDir(stream), name));
}

/** A store whose plan for STREAM is already persisted to disk. */
async function storeWithPersistedPlan(): Promise<StreamSnapshotStore> {
  const store = new StreamSnapshotStore();
  await store.load([]);
  store.setPlan(STREAM, PLAN);
  await store.flush();
  return store;
}

/** Persisted plan, a staged deletion, and a buffered clear of that plan. */
async function stageDeletionWithBufferedClear(): Promise<{
  store: StreamSnapshotStore;
  deletion: StagedDeletion;
}> {
  const store = await storeWithPersistedPlan();
  const deletion = await store.stageDeleteStream(STREAM);
  store.setPlan(STREAM, null);
  return { store, deletion };
}

/** The work plan a fresh store reads back from disk. */
async function reloadWorkPlan(stream: StreamTabId = STREAM): Promise<WorkPlan> {
  const reloaded = new StreamSnapshotStore();
  await reloaded.load([stream]);
  return reloaded.getWorkPlan(stream);
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
  setupPlatform(() => createTempDirPlatform('texra-snapshot-', tempDirs));

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
    expect(snap.subagents).toEqual([]);
    expect(snap.status).toBeUndefined();

    // Cross-host identity: the exact field-scoped filenames every host shares.
    const dir = streamDataDir(STREAM);
    expect(await StorageFS.exists(path.join(dir, 'workPlan.json'))).toBe(true);
    expect(await StorageFS.exists(path.join(dir, 'usageStats.json'))).toBe(
      true,
    );
  });

  it('discards a malformed usage delta LOUDLY instead of silently zeroing accumulated cost', async () => {
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const writer = new StreamSnapshotStore();

    void writer.addUsage(STREAM, RUN, usage(100, 20, 0.5));
    // A delta with an uncoercible numeric field must not wipe out the
    // already-accumulated cost, and must warn rather than fail silently.
    void writer.addUsage(STREAM, RUN, {
      ...usage(50, 10, 0.25),
      inputTokens: 'not-a-number' as unknown as number,
    });

    await writer.flush();

    const reader = new StreamSnapshotStore();
    const snap = await reader.read(STREAM);
    expect(snap.runUsage[RUN]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamSnapshotStore',
      expect.stringContaining('Discarding malformed usage delta'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('persists durable run facts directly from session events and ignores goalPaused', async () => {
    const events = new SessionEventHub();
    const writer = new StreamSnapshotStore();
    const detach = writer.attachSessionEvents(events);
    const output = outputFile('paper.tex', 1);
    const failure = compileFailure('paper.tex', 1);
    const executionId = 'a1b2c3d4' as ExecutionId;
    const runConfig = toolUseConfig('session-search', 'kimi26T');
    const extendedUsage = {
      ...usage(100, 20, 0.5),
      elapsedTime: 1.5,
      percentageCached: 25,
      reasoningTokens: 7,
      toolUseTokens: 4,
    };

    await getExecutionStore(executionId).writeConfig(runConfig);

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.start',
        descriptor: buildRunDescriptor({
          streamId: STREAM,
          executionId,
          agent: 'session-label',
          category: AgentCategory.ToolUse,
          kind: 'agent',
        }),
      },
    });
    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.config',
        streamId: STREAM,
        executionId,
        config: runConfig,
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
        payload: {
          streamId: STREAM,
          storageKey: RUN,
          usage: extendedUsage,
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
    expect(snap.runUsage[RUN]).not.toHaveProperty('elapsedTime');
    expect(snap.runUsage[RUN]).not.toHaveProperty('percentageCached');
    expect(snap.runUsage[RUN]).not.toHaveProperty('reasoningTokens');
    expect(snap.runUsage[RUN]).not.toHaveProperty('toolUseTokens');
    expect(snap.executionId).toBe(executionId);
    expect(snap.description).toBe('session-search / kimi26T');
    expect(snap.parentStreamId).toBe(OTHER_STREAM);
    expect(reader.getRunConfig(STREAM)).toEqual(runConfig);
    expect(reader.getRunDescriptor(STREAM)).toMatchObject({
      streamId: STREAM,
      executionId,
      agent: 'session-label',
      category: AgentCategory.ToolUse,
      kind: 'agent',
    });

    const goalPausedOnly = await new StreamSnapshotStore().read(OTHER_STREAM);
    expect(goalPausedOnly.todos).toEqual([]);
    expect(goalPausedOnly.plan).toBeNull();
    expect(goalPausedOnly.runUsage).toEqual({});
  });

  it('treats run.start as authoritative after run.config synthesizes identity', async () => {
    const events = new SessionEventHub();
    const writer = new StreamSnapshotStore();
    const detach = writer.attachSessionEvents(events);
    const executionId = 'a1b2c3d4' as ExecutionId;
    const runConfig = toolUseConfig('worker-agent');
    const workflowDescriptor = buildRunDescriptor({
      streamId: STREAM,
      executionId,
      agent: 'workflow-script',
      category: AgentCategory.Workflow,
      kind: 'workflowScript',
    });

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.config',
        streamId: STREAM,
        executionId,
        config: runConfig,
      },
    });
    expect(writer.getRunDescriptor(STREAM)).toMatchObject({
      agent: 'worker-agent',
      kind: 'agent',
    });

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.start',
        descriptor: workflowDescriptor,
      },
    });
    detach();
    await writer.flush();

    expect(writer.getRunDescriptor(STREAM)).toEqual(workflowDescriptor);
    const reader = new StreamSnapshotStore();
    await reader.load([STREAM]);
    expect(reader.getExecutionId(STREAM)).toBe(executionId);
    expect(reader.getRunDescriptor(STREAM)).toEqual(workflowDescriptor);
  });

  it('returns an empty (valid) snapshot for a stream with no sidecar', async () => {
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.streamId).toBe(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
    expect(snap.runUsage).toEqual({});
  });

  it('degrades a structurally unreadable work plan to empty LOUDLY (not via a silent .catch)', async () => {
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    // A non-object top-level shape survives the `!raw` guard but fails the
    // object parse, so the read must warn rather than swallow it.
    await writeStreamFile(STREAM, 'workPlan.json', ['not', 'a', 'work plan']);

    const snap = await new StreamSnapshotStore().read(STREAM);

    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamSnapshotStore',
      expect.stringContaining('unreadable persisted work plan'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('migrates the legacy nested {runId:{round}} shape to flat ONCE at the load entry', async () => {
    await writeStreamFile(STREAM, 'missingOutputs.json', {
      'run-1': { '0': ['a.tex'], '1': ['b.tex'] },
    });

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    await store.flush();

    // The on-disk file is now FLAT — migrated once at the load entry, never
    // re-resolved on subsequent reads.
    const raw = await readStreamFile(STREAM, 'missingOutputs.json');
    expect(raw).toEqual({ '0': ['a.tex'], '1': ['b.tex'] });
    // …and a fresh read sees the flattened data.
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.missingOutputsByRound).toEqual({
      '0': ['a.tex'],
      '1': ['b.tex'],
    });
  });

  it('seeds existing disk data before an unloaded usage mutation, so it is not erased', async () => {
    // A prior session persisted usage for run-1.
    await writeStreamFile(STREAM, 'usageStats.json', {
      'run-1': usage(100, 20, 0.5),
    });

    // A fresh store (NOT load()ed) handles a delta for a NEW run.
    const store = new StreamSnapshotStore();
    void store.addUsage(STREAM, 'run-2' as StorageKey, usage(50, 10, 0.25));
    await store.flush();

    // run-1 (prior) survives — the unseeded write did not clobber it.
    const raw = await readStreamFile(STREAM, 'usageStats.json');
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
    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
      'run-corrupt': 'this-is-not-a-usage-object',
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new StreamSnapshotStore();
    // Force a seed + a write for an unrelated run so writeUsage() actually
    // rewrites usageStats.json from the in-memory accumulators.
    const pending = store.addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    await Promise.resolve(pending);
    await store.flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    const raw = await readStreamFile(STREAM, 'usageStats.json');
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
    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

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

    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('returns pre-seed usage only after a partial preload baseline is merged', async () => {
    await writeStreamFile(OTHER_STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

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

    const raw = await readStreamFile(OTHER_STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('includes the disk baseline in a pre-seed usage result for the same run', async () => {
    await writeStreamFile(OTHER_STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

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

    const raw = await readStreamFile(OTHER_STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 150, outputTokens: 30, cost: 0.75 },
    });
  });

  it('returns output files immediately for streams outside a partial preload without erasing disk outputs', async () => {
    const prior = outputFile('prior.tex', 0);
    const next = outputFile('next.tex', 1);
    await writeStreamFile(OTHER_STREAM, 'outputFiles.json', { '0': [prior] });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.addOutputFiles(OTHER_STREAM, { 1: [next] });
    const returned = store.getOutputFiles(OTHER_STREAM);
    returned[1]?.push(outputFile('injected.tex', 1));
    expect(store.getOutputFiles(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'outputFiles.json');
    expect(raw).toMatchObject({
      '0': [prior],
      '1': [next],
    });
  });

  it('keeps output overlays when flattening legacy output files after preload', async () => {
    const prior = outputFile('prior.tex', 0);
    const next = outputFile('next.tex', 1);
    await writeStreamFile(OTHER_STREAM, 'outputFiles.json', {
      [RUN]: { '0': [prior] },
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.addOutputFiles(OTHER_STREAM, { 1: [next] });
    expect(store.getOutputFiles(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'outputFiles.json');
    expect(raw).toEqual({
      '0': [prior],
      '1': [next],
    });
  });

  it('returns missing outputs immediately for streams outside a partial preload without erasing disk markers', async () => {
    // Same race as the output-files case above, replayed for
    // updateMissingOutputs: a stream outside the preloaded set is still
    // unseeded when the mutation lands, so the seed's disk read is racing
    // the caller's read of its own write.
    await writeStreamFile(OTHER_STREAM, 'missingOutputs.json', {
      '0': ['prior.tex'],
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.updateMissingOutputs(OTHER_STREAM, { 1: ['next.tex'] });
    // The overlay applies eagerly, so this synchronous read-back sees the
    // mutation while the seed is still in flight.
    expect(store.getMissingOutputs(OTHER_STREAM)[1]).toEqual(['next.tex']);
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'missingOutputs.json');
    expect(raw).toMatchObject({
      '0': ['prior.tex'],
      '1': ['next.tex'],
    });
  });

  it('rejects malformed missing-output patches before mutating memory or persisted state', async () => {
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
    expect(await readStreamFile(STREAM, 'missingOutputs.json')).toEqual({
      '0': ['prior.tex'],
    });

    store.updateMissingOutputs(STREAM, { 1: ['next.tex'] });
    expect(store.getMissingOutputs(STREAM)).toEqual({
      0: ['prior.tex'],
      1: ['next.tex'],
    });
    await store.flush();
    expect(await readStreamFile(STREAM, 'missingOutputs.json')).toEqual({
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
    await writeStreamFile(OTHER_STREAM, 'missingOutputs.json', {
      '0': ['stale.tex'],
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.clearMissingOutputs(OTHER_STREAM);
    store.updateMissingOutputs(OTHER_STREAM, { 1: ['next.tex'] });
    expect(store.getMissingOutputs(OTHER_STREAM)).toEqual({ 1: ['next.tex'] });
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'missingOutputs.json');
    expect(raw).toEqual({ '1': ['next.tex'] });
  });

  it('replays a later clearMissingOutputs over an earlier updateMissingOutputs on an unseeded stream', async () => {
    await writeStreamFile(OTHER_STREAM, 'missingOutputs.json', {
      '0': ['stale.tex'],
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.updateMissingOutputs(OTHER_STREAM, { 1: ['next.tex'] });
    store.clearMissingOutputs(OTHER_STREAM);
    expect(store.getMissingOutputs(OTHER_STREAM)).toEqual({});
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'missingOutputs.json');
    expect(raw).toEqual({});
  });

  it('returns compile failures immediately for streams outside a partial preload without erasing disk markers', async () => {
    const prior = compileFailure('prior.tex', 0);
    const next = compileFailure('next.tex', 1);
    await writeStreamFile(OTHER_STREAM, 'compileFailures.json', {
      '0': [prior],
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.updateCompileFailures(OTHER_STREAM, { 1: [next] });
    // Eagerly applied for the same reason as the missing-outputs case above.
    expect(store.getCompileFailures(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'compileFailures.json');
    expect(raw).toMatchObject({
      '0': [prior],
      '1': [next],
    });
  });

  it('makes task state readable immediately while preserving later seeded sidecars', async () => {
    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

    const store = new StreamSnapshotStore();
    const runConfig = toolUseConfig();
    const executionId = 'abc123' as ExecutionId;

    store.setRunConfig(STREAM, runConfig, executionId);
    expect(store.getRunConfig(STREAM)).toEqual(runConfig);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
    await expect(
      Promise.resolve(store.addUsage(STREAM, RUN_2, usage(50, 10, 0.25))),
    ).resolves.toMatchObject({
      inputTokens: 50,
      outputTokens: 10,
      cost: 0.25,
    });
    await store.flush();

    expect(store.getRunConfig(STREAM)).toEqual(runConfig);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: { inputTokens: 100, outputTokens: 20, cost: 0.5 },
      [RUN_2]: { inputTokens: 50, outputTokens: 10, cost: 0.25 },
    });
  });

  it('forces the current meta schema version over stale cached meta', async () => {
    await installPlatform();
    const store = new StreamSnapshotStore();
    await store.load([]);

    // Every field lives on one record keyed by stream id, so priming a stale
    // in-memory meta means seeding just the `meta` field of that record.
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
    const taskState = toolUseTaskState('legacy-search');
    await writeMetaFile(STREAM, {
      taskState,
    });

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    store.setDescription(STREAM, 'Prior session');
    await store.flush();

    const raw = (await readStreamFile(STREAM, 'meta.json')) as {
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
    const executionId = 'abc123' as ExecutionId;
    const taskState = toolUseTaskState('legacy-search');
    await writeMetaFile(STREAM, {
      executionId,
      taskState,
    });
    await StorageFS.ensureDir(resolveRunStoragePath(executionId));
    await StorageFS.write(
      path.join(resolveRunStoragePath(executionId), 'config.json'),
      '{',
    );

    const store = new StreamSnapshotStore();
    await expect(store.load([STREAM])).resolves.toBeUndefined();

    expect(store.getRunConfig(STREAM)).toEqual(taskState.agentConfig);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
  });

  it('resolves the descriptor execution id everywhere when the legacy mirror is malformed', async () => {
    await installPlatform();
    const executionId = 'aa11bb22' as ExecutionId;
    const runConfig = toolUseConfig('legacy-search');
    await getExecutionStore(executionId).writeConfig(runConfig);
    await writeMetaFile(STREAM, {
      // A legacy sidecar whose top-level mirror never held a real execution id.
      executionId: 'not-an-execution-id!',
      runDescriptor: buildRunDescriptor({
        streamId: STREAM,
        executionId,
        agent: 'legacy-search',
        category: AgentCategory.ToolUse,
        kind: 'agent',
      }),
    });

    const store = new StreamSnapshotStore();
    // The meta-only scan the execution→stream resolver runs, and the seeded
    // accessors, must agree instead of one finding the run and the other not.
    expect(await store.readPersistedExecutionId(STREAM)).toBe(executionId);
    await store.load([STREAM]);

    expect(store.getExecutionId(STREAM)).toBe(executionId);
    expect(store.getExecutionIdMap().get(STREAM)).toBe(executionId);
    expect((await store.read(STREAM)).executionId).toBe(executionId);
  });

  it('completes the run kind of a descriptor written before that field existed', async () => {
    await installPlatform();
    const store = new StreamSnapshotStore();
    const legacy = async (
      stream: StreamTabId,
      executionId: ExecutionId,
      agent: string,
    ): Promise<void> => {
      await getExecutionStore(executionId).writeConfig(toolUseConfig(agent));
      await writeMetaFile(stream, {
        executionId,
        // A descriptor persisted before #9119 added `kind`.
        runDescriptor: {
          schemaVersion: RUN_DESCRIPTOR_SCHEMA_VERSION,
          streamId: stream,
          executionId,
          agent,
          category: AgentCategory.ToolUse,
          configRef: {
            kind: 'executionConfig',
            executionId,
            path: `executions/${executionId}/config.json`,
          },
        },
      });
    };
    await legacy(STREAM, 'cc33dd44' as ExecutionId, 'bash');
    await legacy(OTHER_STREAM, 'dd44ee55' as ExecutionId, 'legacy-search');

    await store.load([STREAM, OTHER_STREAM]);

    // Completed at the read boundary, so no consumer re-derives the kind from
    // the agent name for itself.
    expect(store.getRunDescriptor(STREAM)?.kind).toBe('process');
    expect(store.getRunDescriptor(OTHER_STREAM)?.kind).toBe('agent');
  });

  it('keeps a runtime run-config update that arrives during async hydration', async () => {
    await installPlatform();
    const oldExecutionId = 'abc123' as ExecutionId;
    const newExecutionId = 'def456' as ExecutionId;
    const oldConfig = toolUseConfig('old-search');
    const newConfig = toolUseConfig('new-search');
    await writeMetaFile(STREAM, {
      executionId: oldExecutionId,
    });
    await getExecutionStore(oldExecutionId).writeConfig(oldConfig);

    const store = new StreamSnapshotStore();
    const wasRuntimeUpdateInjected = injectDuringExecutionConfigHydration(
      oldExecutionId,
      () => store.setRunConfig(STREAM, newConfig, newExecutionId),
    );

    await store.load([STREAM]);
    expect(wasRuntimeUpdateInjected).toHaveBeenCalledOnce();
    expect(store.getRunConfig(STREAM)).toEqual(newConfig);
    expect(store.getExecutionId(STREAM)).toBe(newExecutionId);

    await store.flush();
    const raw = (await readStreamFile(STREAM, 'meta.json')) as {
      executionId?: unknown;
      runDescriptor?: { executionId?: unknown; agent?: unknown };
    };
    expect(raw.executionId).toBe(newExecutionId);
    expect(raw.runDescriptor).toMatchObject({
      executionId: newExecutionId,
      agent: 'new-search',
    });
  });

  it('keeps a same-execution model switch that arrives during async hydration', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    const persisted = toolUseConfig('search', 'deepseekproT');
    const switched = toolUseConfig('search', 'kimi26T');
    await writeMetaFile(STREAM, {
      executionId,
    });
    await getExecutionStore(executionId).writeConfig(persisted);

    const store = new StreamSnapshotStore();
    // A model switch rewrites the execution config and re-emits `run.config`
    // for the SAME execution, so the identity check cannot tell the two apart:
    // the live event wins because the seed only fills what it did not receive.
    const wasModelSwitchInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => store.setRunConfig(STREAM, switched, executionId),
    );

    await store.load([STREAM]);

    expect(wasModelSwitchInjected).toHaveBeenCalledOnce();
    expect(store.getRunConfig(STREAM)?.model).toBe('kimi26T');
    expect(store.getExecutionId(STREAM)).toBe(executionId);
  });

  it('does not re-derive the run.start descriptor when a seed re-reads disk meta', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    const runConfig = toolUseConfig('worker-agent');
    const workflowDescriptor = buildRunDescriptor({
      streamId: STREAM,
      executionId,
      agent: 'workflow-script',
      category: AgentCategory.Workflow,
      kind: 'workflowScript',
    });
    await getExecutionStore(executionId).writeConfig(runConfig);

    const store = new StreamSnapshotStore();
    store.setRunDescriptor(workflowDescriptor);
    store.setRunConfig(STREAM, runConfig, executionId);
    await store.flush();

    // Disk meta drops back to the pre-descriptor shape for the same execution.
    // Re-seeding may read it, but may not synthesize a competing identity from
    // the execution config over the one run.start emitted.
    await writeMetaFile(STREAM, {
      executionId,
    });
    await store.load([STREAM]);

    expect(store.getRunDescriptor(STREAM)).toEqual(workflowDescriptor);
    expect(store.getExecutionId(STREAM)).toBe(executionId);
  });

  it('adopts run identity from disk when meta names a different execution', async () => {
    await installPlatform();
    const liveExecutionId = 'abc123' as ExecutionId;
    const foreignExecutionId = 'def456' as ExecutionId;
    const foreignConfig = toolUseConfig('foreign-search');

    const store = new StreamSnapshotStore();
    store.setRunConfig(STREAM, toolUseConfig('live-search'), liveExecutionId);
    await store.flush();

    await getExecutionStore(foreignExecutionId).writeConfig(foreignConfig);
    await writeMetaFile(STREAM, {
      executionId: foreignExecutionId,
    });
    await store.load([STREAM]);

    expect(store.getExecutionId(STREAM)).toBe(foreignExecutionId);
    expect(store.getRunConfig(STREAM)).toEqual(foreignConfig);
    expect(store.getRunDescriptor(STREAM)).toMatchObject({
      executionId: foreignExecutionId,
      agent: 'foreign-search',
    });
  });

  it('refreshes the run config from disk when another host switched the model', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    await writeMetaFile(STREAM, {
      executionId,
    });
    await getExecutionStore(executionId).writeConfig(
      toolUseConfig('search', 'deepseekproT'),
    );

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunConfig(STREAM)?.model).toBe('deepseekproT');

    // The model switch runs in another host: it rewrites the execution config
    // for the SAME execution and this store never sees the `run.config` event.
    await getExecutionStore(executionId).writeConfig(
      toolUseConfig('search', 'kimi26T'),
    );
    await store.load([STREAM]);

    expect(store.getRunConfig(STREAM)?.model).toBe('kimi26T');
    expect(store.getExecutionId(STREAM)).toBe(executionId);
  });

  it('replaces a legacy run config once meta names a real execution', async () => {
    await installPlatform();
    const legacyTaskState = toolUseTaskState('legacy-search');
    await writeMetaFile(STREAM, {
      taskState: legacyTaskState,
    });

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunConfig(STREAM)).toEqual(legacyTaskState.agentConfig);
    expect(store.getRunDescriptor(STREAM)).toBeUndefined();

    // A legacy config carries no descriptor, so the handoff cannot be detected
    // from the descriptor half alone: the pair still has to move together.
    const executionId = 'def456' as ExecutionId;
    const handoffConfig = toolUseConfig('handoff-search');
    await getExecutionStore(executionId).writeConfig(handoffConfig);
    await writeMetaFile(STREAM, {
      executionId,
    });
    await store.load([STREAM]);

    expect(store.getRunConfig(STREAM)).toEqual(handoffConfig);
    expect(store.getRunDescriptor(STREAM)).toMatchObject({
      executionId,
      agent: 'handoff-search',
    });
  });

  it('drops run identity when disk meta no longer names an execution', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    await writeMetaFile(STREAM, {
      executionId,
    });
    await getExecutionStore(executionId).writeConfig(toolUseConfig());

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunDescriptor(STREAM)).toMatchObject({ executionId });

    await writeMetaFile(STREAM, {
      description: 'Detached tab',
    });
    await store.load([STREAM]);

    expect(store.getRunDescriptor(STREAM)).toBeUndefined();
    expect(store.getRunConfig(STREAM)).toBeUndefined();
    expect(store.getExecutionId(STREAM)).toBeUndefined();
    expect(store.getDescription(STREAM)).toBe('Detached tab');
  });

  it('does not attach the seeded run config to a run.start that lands during hydration', async () => {
    await installPlatform();
    const oldExecutionId = 'abc123' as ExecutionId;
    const newExecutionId = 'def456' as ExecutionId;
    const oldConfig = toolUseConfig('old-search');
    await writeMetaFile(STREAM, {
      executionId: oldExecutionId,
    });
    await getExecutionStore(oldExecutionId).writeConfig(oldConfig);

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunConfig(STREAM)).toEqual(oldConfig);

    const newDescriptor = buildRunDescriptor({
      streamId: STREAM,
      executionId: newExecutionId,
      agent: 'workflow-script',
      category: AgentCategory.Workflow,
      kind: 'workflowScript',
    });
    // `run.start` for the next execution lands while the seed is still reading
    // the previous one's config, which belongs to neither the new identity nor
    // this stream any more.
    const wasRunStartInjected = injectDuringExecutionConfigHydration(
      oldExecutionId,
      () => store.setRunDescriptor(newDescriptor),
    );
    await store.load([STREAM]);

    expect(wasRunStartInjected).toHaveBeenCalledOnce();
    expect(store.getRunDescriptor(STREAM)).toEqual(newDescriptor);
    expect(store.getRunConfig(STREAM)).toBeUndefined();
  });

  it('persists a late reset and round patch that arrive during async hydration', async () => {
    await installPlatform();
    const executionId = 'c0ffee' as ExecutionId;
    await Promise.all([
      writeMetaFile(STREAM, {
        executionId,
      }),
      writeStreamFile(STREAM, 'missingOutputs.json', { '0': ['stale.tex'] }),
      getExecutionStore(executionId).writeConfig(toolUseConfig()),
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
      readStreamFile(STREAM, 'missingOutputs.json'),
      readStreamFile(STREAM, 'usageStats.json'),
    ]);
    expect(missingOutputs).toEqual({ '1': ['late.tex'] });
    expect(usageStats).toMatchObject({ [RUN]: usage(10, 2, 0.1) });
  });

  it('does not recreate sidecars when a stream is deleted during hydration', async () => {
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const executionId = 'deadbeef' as ExecutionId;
    await Promise.all([
      writeMetaFile(STREAM, {
        executionId,
        activeRunId: RUN,
      }),
      writeStreamFile(STREAM, 'missingOutputs.json', {
        [RUN]: { '0': ['legacy.tex'] },
      }),
      getExecutionStore(executionId).writeConfig(toolUseConfig()),
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
    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunUsage(STREAM).get(RUN)).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });

    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(3, 4, 0.01),
    });
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

    expect(await reloadWorkPlan()).toMatchObject({
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
    const store = await storeWithPersistedPlan();

    const deletion = await store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, null);
    await store.flush();

    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);

    await deletion.rollback();
    await store.flush();

    expect(await reloadWorkPlan()).toMatchObject({
      todos: [],
      plan: null,
      planSummary: null,
    });
  });

  it('drains writes that arrive as rollback replay returns', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    type ReplayHarness = {
      replayStagedWrites: (
        stream: StreamTabId,
        state: unknown,
      ) => Promise<void>;
    };
    const replayHarness = store as unknown as ReplayHarness;
    const replay = replayHarness.replayStagedWrites.bind(replayHarness);
    const replaySpy = vi
      .spyOn(replayHarness, 'replayStagedWrites')
      .mockImplementationOnce(async (stream, state) => {
        await replay(stream, state);
        store.setTodos(STREAM, [TODO]);
      })
      .mockImplementation(replay);

    await deletion.rollback();

    replaySpy.mockRestore();
    expect(await reloadWorkPlan()).toMatchObject({
      plan: null,
      todos: [TODO],
    });
    await store.deleteStream(STREAM);
  });

  it('serializes overlapping staged deletions for one stream', async () => {
    const store = await storeWithPersistedPlan();

    const firstDeletion = await store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, null);
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
    await deletion.rollback();

    expect(await reloadWorkPlan()).toMatchObject({
      plan: null,
      planSummary: null,
    });
  });

  it('allows retry after staged rollback fails', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
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

    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('retains buffered writes when rollback persistence fails', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const writeError = new Error('snapshot disk is full');
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockImplementationOnce(async () => {
        throw writeError;
      })
      .mockImplementation(writeAtomic);

    await expect(deletion.rollback()).rejects.toBe(writeError);

    const revisedPlan: Plan = { objective: 'Use the recovered draft' };
    writeSpy.mockRestore();
    store.setPlan(STREAM, revisedPlan);
    await store.flush();
    expect((await reloadWorkPlan()).plan).toEqual(revisedPlan);

    const retry = await store.stageDeleteStream(STREAM);
    await retry.rollback();
    expect((await reloadWorkPlan()).plan).toEqual(revisedPlan);
    await store.deleteStream(STREAM);
  });

  it('retries retained live rollback writes during flush', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);

    await expect(deletion.rollback()).rejects.toBe(writeError);

    writeSpy.mockRestore();
    await store.flush();
    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('waits unrelated writes before flush reports a recovery failure', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const initialWriteError = new Error('snapshot disk is full');
    const initialWriteSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(initialWriteError);
    await expect(deletion.rollback()).rejects.toBe(initialWriteError);
    initialWriteSpy.mockRestore();

    let releaseUnrelatedWrite = () => {};
    const unrelatedWriteGate = new Promise<void>((resolve) => {
      releaseUnrelatedWrite = resolve;
    });
    const recoveryError = new Error('snapshot disk remains full');
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    const streamPlanPath = path.join(streamDataDir(STREAM), 'workPlan.json');
    const otherPlanPath = path.join(
      streamDataDir(OTHER_STREAM),
      'workPlan.json',
    );
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockImplementation(async (target, data) => {
        if (target === streamPlanPath) throw recoveryError;
        if (target === otherPlanPath) await unrelatedWriteGate;
        return writeAtomic(target, data);
      });
    store.setPlan(OTHER_STREAM, PLAN);
    let flushSettled = false;
    const flushing = store.flush().finally(() => {
      flushSettled = true;
    });
    void flushing.catch(() => undefined);

    await vi.waitFor(() =>
      expect(writeSpy).toHaveBeenCalledWith(streamPlanPath, expect.any(String)),
    );
    expect(flushSettled).toBe(false);

    releaseUnrelatedWrite();
    await expect(flushing).rejects.toBe(recoveryError);
    writeSpy.mockRestore();
    expect((await reloadWorkPlan(OTHER_STREAM)).plan).toEqual(PLAN);

    await store.flush();
    await store.deleteStream(STREAM);
    await store.deleteStream(OTHER_STREAM);
  });

  it('does not recreate live storage while setup residue is staged', async () => {
    const store = await storeWithPersistedPlan();
    const liveDir = streamDataDir(STREAM);
    const stagedDir = stagedStreamDataDir(STREAM);
    await StorageFS.ensureDir(STREAM_DATA_DELETION_DIR);
    await StorageFS.rename(liveDir, stagedDir);
    const stat = StorageFS.stat.bind(StorageFS);
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockImplementationOnce(async (target) => {
        expect(target).toBe(stagedDir);
        store.setPlan(STREAM, null);
        return stat(target);
      });

    await expect(store.stageDeleteStream(STREAM)).rejects.toThrow(
      'unreconciled snapshot deletion',
    );

    statSpy.mockRestore();
    expect(await StorageFS.exists(liveDir)).toBe(false);
    expect(await StorageFS.exists(stagedDir)).toBe(true);
    const retry = await store.stageDeleteStream(STREAM);
    await retry.rollback();
    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('drains dirty writes when deletion staging fails during setup', async () => {
    const store = await storeWithPersistedPlan();
    const writeError = new Error('snapshot disk is full');
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError)
      .mockImplementation(writeAtomic);

    store.setPlan(STREAM, null);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());

    const setupError = new Error('cannot inspect staged snapshot');
    const stat = StorageFS.stat.bind(StorageFS);
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockRejectedValueOnce(setupError)
      .mockImplementation(stat);

    await expect(store.stageDeleteStream(STREAM)).rejects.toBe(setupError);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(2));

    statSpy.mockRestore();
    writeSpy.mockRestore();
    await store.flush();
    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('keeps writes buffered when a staging rename fails after moving data', async () => {
    const store = await storeWithPersistedPlan();
    const renameError = new Error('snapshot rename acknowledgement failed');
    const rename = StorageFS.rename.bind(StorageFS);
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockImplementationOnce(async (source, destination) => {
        store.setPlan(STREAM, null);
        await rename(source, destination);
        throw renameError;
      })
      .mockImplementation(rename);

    await expect(store.stageDeleteStream(STREAM)).rejects.toBe(renameError);

    store.setPlan(STREAM, PLAN);
    renameSpy.mockRestore();
    const retry = await store.stageDeleteStream(STREAM);
    await retry.rollback();
    expect((await reloadWorkPlan()).plan).toEqual(PLAN);
    await store.deleteStream(STREAM);
  });

  it('mirrors writes when rollback moved data before reporting failure', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const renameError = new Error('snapshot rename acknowledgement failed');
    const rename = StorageFS.rename.bind(StorageFS);
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockImplementationOnce(async (source, destination) => {
        await rename(source, destination);
        throw renameError;
      });

    await expect(deletion.rollback()).rejects.toBe(renameError);

    renameSpy.mockRestore();
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    const writeFinished = pDefer<void>();
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockImplementation((...args) => {
        const write = writeAtomic(...args);
        writeFinished.resolve(write);
        return write;
      });
    store.setTodos(STREAM, [TODO]);
    await writeFinished.promise;
    expect(writeSpy).toHaveBeenCalledTimes(1);
    writeSpy.mockRestore();

    expect(await reloadWorkPlan()).toMatchObject({
      plan: null,
      todos: [TODO],
    });
    await store.flush();
    await store.deleteStream(STREAM);
  });

  it('retains prior rollback writes when retry setup also fails', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const rollbackError = new Error('snapshot directory is still locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(rollbackError);

    await expect(deletion.rollback()).rejects.toBe(rollbackError);

    renameSpy.mockRestore();
    const setupError = new Error('cannot inspect staged snapshot');
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockRejectedValueOnce(setupError);
    await expect(store.stageDeleteStream(STREAM)).rejects.toBe(setupError);

    statSpy.mockRestore();
    store.setTodos(STREAM, [TODO]);
    const retry = await store.stageDeleteStream(STREAM);
    await retry.rollback();
    expect(await reloadWorkPlan()).toMatchObject({
      plan: null,
      todos: [TODO],
    });
    await store.deleteStream(STREAM);
  });

  it('revalidates storage during setup recovery before returning', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);

    await expect(deletion.rollback()).rejects.toBe(writeError);

    writeSpy.mockRestore();
    const renameError = new Error('snapshot directory is still locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockImplementationOnce(async () => {
        store.setTodos(STREAM, [TODO]);
        throw renameError;
      });
    await expect(store.stageDeleteStream(STREAM)).rejects.toBe(renameError);

    renameSpy.mockRestore();
    expect(await reloadWorkPlan()).toMatchObject({
      plan: null,
      todos: [TODO],
    });
    await store.deleteStream(STREAM);
  });

  it('retries buffered writes after staged-directory reconciliation', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const rollbackError = new Error('snapshot directory is still locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(rollbackError);

    await expect(deletion.rollback()).rejects.toBe(rollbackError);

    renameSpy.mockRestore();
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);
    await expect(
      store.reconcileStagedDeletions(new Set([STREAM])),
    ).rejects.toBe(writeError);

    writeSpy.mockRestore();
    await expect(
      store.reconcileStagedDeletions(new Set([STREAM])),
    ).resolves.toEqual({
      restored: [],
      pendingCleanup: [],
      discarded: [],
    });
    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('keeps the staged base when failed rollback data also has live residue', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    void store.addUsage(STREAM, RUN, usage(100, 20, 0.5));
    await store.flush();
    const deletion = await store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, null);
    const rollbackError = new Error('snapshot directory is still locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(rollbackError);

    await expect(deletion.rollback()).rejects.toBe(rollbackError);

    renameSpy.mockRestore();
    await StorageFS.ensureDir(streamDataDir(STREAM));
    await expect(
      store.reconcileStagedDeletions(new Set([STREAM])),
    ).resolves.toEqual({
      restored: [STREAM],
      pendingCleanup: [],
      discarded: [],
    });
    const reloaded = await new StreamSnapshotStore().read(STREAM);
    expect(reloaded.plan).toBeNull();
    expect(reloaded.runUsage[RUN]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });
    await store.deleteStream(STREAM);
  });

  it('discards staged residue when failed rollback data has a live base', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    store.setPlan(STREAM, PLAN);
    void store.addUsage(STREAM, RUN, usage(100, 20, 0.5));
    await store.flush();
    const deletion = await store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, null);
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);

    await expect(deletion.rollback()).rejects.toBe(writeError);

    writeSpy.mockRestore();
    const stagedDir = stagedStreamDataDir(STREAM);
    await StorageFS.ensureDir(stagedDir);
    await StorageFS.writeAtomic(
      path.join(stagedDir, 'workPlan.json'),
      JSON.stringify({
        todos: [],
        plan: PLAN,
        planSummary: PLAN_SUMMARY,
      }),
    );
    await expect(
      store.reconcileStagedDeletions(new Set([STREAM])),
    ).resolves.toEqual({
      restored: [],
      pendingCleanup: [],
      discarded: [STREAM],
    });

    const reloaded = await new StreamSnapshotStore().read(STREAM);
    expect(reloaded.plan).toBeNull();
    expect(reloaded.runUsage[RUN]).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    });
    expect(await StorageFS.exists(stagedDir)).toBe(false);
    await store.deleteStream(STREAM);
  });

  it('does not restore staged residue after a live base disappears', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);

    await expect(deletion.rollback()).rejects.toBe(writeError);

    writeSpy.mockRestore();
    const liveDir = streamDataDir(STREAM);
    const stagedDir = stagedStreamDataDir(STREAM);
    await StorageFS.delete(liveDir, { recursive: true });
    await StorageFS.ensureDir(stagedDir);
    await StorageFS.writeAtomic(
      path.join(stagedDir, 'workPlan.json'),
      JSON.stringify({
        todos: [],
        plan: PLAN,
        planSummary: PLAN_SUMMARY,
      }),
    );

    await expect(
      store.reconcileStagedDeletions(new Set([STREAM])),
    ).resolves.toEqual({
      restored: [],
      pendingCleanup: [],
      discarded: [STREAM],
    });
    expect((await reloadWorkPlan()).plan).toBeNull();
    expect(await StorageFS.exists(stagedDir)).toBe(false);
    await store.deleteStream(STREAM);
  });

  it('recreates live storage from buffered writes when both bases vanish', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const rollbackError = new Error('snapshot directory is still locked');
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(rollbackError);

    await expect(deletion.rollback()).rejects.toBe(rollbackError);

    renameSpy.mockRestore();
    await StorageFS.delete(stagedStreamDataDir(STREAM), { recursive: true });
    await store.flush();
    expect((await reloadWorkPlan()).plan).toBeNull();
    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(true);
    await store.deleteStream(STREAM);
  });

  it('serializes a staging retry behind failed rollback reconciliation', async () => {
    const { store, deletion } = await stageDeletionWithBufferedClear();
    const rollbackError = new Error('snapshot directory is still locked');
    const rollbackSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockRejectedValueOnce(rollbackError);

    await expect(deletion.rollback()).rejects.toBe(rollbackError);

    rollbackSpy.mockRestore();
    let releaseRename = () => {};
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    const rename = StorageFS.rename.bind(StorageFS);
    const recoverySpy = vi
      .spyOn(StorageFS, 'rename')
      .mockImplementationOnce(async (source, destination) => {
        await renameGate;
        return rename(source, destination);
      })
      .mockImplementation(rename);
    const reconciliation = store.reconcileStagedDeletions(new Set([STREAM]));
    await vi.waitFor(() => expect(recoverySpy).toHaveBeenCalledTimes(1));

    let retrySettled = false;
    const retryPromise = store.stageDeleteStream(STREAM).then((retry) => {
      retrySettled = true;
      return retry;
    });
    await Promise.resolve();
    expect(retrySettled).toBe(false);

    releaseRename();
    await expect(reconciliation).resolves.toEqual({
      restored: [STREAM],
      pendingCleanup: [],
      discarded: [],
    });
    const retry = await retryPromise;
    await retry.rollback();
    recoverySpy.mockRestore();

    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('restores committed residue for complete orphan cleanup', async () => {
    const store = await storeWithPersistedPlan();
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
    const store = await storeWithPersistedPlan();
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

    statSpy.mockRestore();
    expect(await StorageFS.exists(liveDir)).toBe(true);
    await store.deleteStream(STREAM);
  });

  it('settles staging and retains writes when setup recovery fails', async () => {
    const store = await storeWithPersistedPlan();
    const setupError = new Error('staging directory is locked');
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);
    const ensureDir = StorageFS.ensureDir.bind(StorageFS);
    const ensureDirSpy = vi
      .spyOn(StorageFS, 'ensureDir')
      .mockImplementationOnce(async () => {
        store.setPlan(STREAM, null);
        throw setupError;
      })
      .mockImplementation(ensureDir);

    const error = await store.stageDeleteStream(STREAM).catch((cause) => cause);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([setupError, writeError]);

    ensureDirSpy.mockRestore();
    writeSpy.mockRestore();
    const retry = await store.stageDeleteStream(STREAM);
    await retry.rollback();
    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('serializes setup recovery before another staging attempt can cancel its writes', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const streamPlanPath = path.join(streamDataDir(STREAM), 'workPlan.json');
    let releaseInitialWrite = () => {};
    const initialWriteGate = new Promise<void>((resolve) => {
      releaseInitialWrite = resolve;
    });
    let initialWriteStarted = () => {};
    const initialWriteStart = new Promise<void>((resolve) => {
      initialWriteStarted = resolve;
    });
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    vi.spyOn(StorageFS, 'writeAtomic').mockImplementation(
      async (target, contents) => {
        if (target === streamPlanPath) {
          initialWriteStarted();
          await initialWriteGate;
        }
        return writeAtomic(target, contents);
      },
    );

    store.setPlan(STREAM, PLAN);
    await initialWriteStart;
    const setupError = new Error('cannot inspect staged snapshot');
    const stat = StorageFS.stat.bind(StorageFS);
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockImplementationOnce(async () => {
        store.setPlan(STREAM, null);
        throw setupError;
      })
      .mockImplementation(stat);

    const staging = store.stageDeleteStream(STREAM);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const flushing = store.flush();
    const retrying = store.stageDeleteStream(STREAM);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(statSpy).toHaveBeenCalledTimes(1);

    releaseInitialWrite();
    await expect(staging).rejects.toBe(setupError);
    await flushing;
    const retry = await retrying;
    await retry.rollback();

    expect((await reloadWorkPlan()).plan).toBeNull();
    await store.deleteStream(STREAM);
  });

  it('waits for active hydration before staging deletion', async () => {
    await installPlatform();
    const executionId = 'feedface' as ExecutionId;
    const writer = new StreamSnapshotStore();
    await writer.load([]);
    writer.setRunConfig(STREAM, toolUseConfig(), executionId);
    writer.setPlan(STREAM, PLAN);
    await writer.flush();
    await getExecutionStore(executionId).writeConfig(toolUseConfig());

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

    expect((await reloadWorkPlan()).todos).toEqual([TODO]);
  });

  it('does not resurrect a deleted sidecar dir when deleteStream lands during hydration', async () => {
    // applyStreamData awaits execution-config hydration mid-seed. If the
    // stream is deleted during that await, the continuation must not
    // re-resolve a record for the evicted stream and flush merged sidecars,
    // which would recreate `streamData/{id}/` after deleteDir() removed it.
    await installPlatform();
    const dir = streamDataDir(STREAM);
    const executionId = 'dead01' as ExecutionId;
    await Promise.all([
      writeMetaFile(STREAM, {
        executionId,
      }),
      // Legacy nested shape → `missingOutputs` lands in `data.legacyKeys`,
      // arming the merged-sidecar rewrite regardless of overlays.
      writeStreamFile(STREAM, 'missingOutputs.json', {
        'run-1': { '0': ['stale.tex'] },
      }),
      getExecutionStore(executionId).writeConfig(toolUseConfig()),
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

  it('persists a retained seed-gated sidecar on a later successful flush', async () => {
    const store = new StreamSnapshotStore();
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValue(writeError);

    store.setPlan(STREAM, PLAN);
    await expect(store.flush()).rejects.toThrow('sidecar write');

    writeSpy.mockRestore();
    await store.flush();

    expect((await reloadWorkPlan()).plan).toEqual(PLAN);
  });

  it('succeeds when flush durably retries a refresh write failure', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const writeError = new Error('snapshot disk is full');
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    let writeCount = 0;
    vi.spyOn(StorageFS, 'writeAtomic').mockImplementation((...args) => {
      writeCount += 1;
      if (writeCount <= 4) return Promise.reject(writeError);
      return writeAtomic(...args);
    });

    store.setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeCount).toBe(1));
    const refresh = store.load([STREAM]);
    const flushing = store.flush();

    await expect(refresh).rejects.toThrow('Sidecar writes remain dirty');
    await expect(flushing).resolves.toBeUndefined();
    expect((await reloadWorkPlan()).plan).toEqual(PLAN);
  });

  it('lets a newer successful write supersede an older failed value', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);
    const revisedPlan: Plan = { objective: 'Use the revised draft' };

    store.setPlan(STREAM, PLAN);
    store.setPlan(STREAM, revisedPlan);
    await store.flush();

    expect(writeSpy).toHaveBeenCalledTimes(2);
    expect((await reloadWorkPlan()).plan).toEqual(revisedPlan);
  });

  it('retains a mutation queued during a failed refresh', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValue(new Error('snapshot disk is full'));

    store.setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    const refresh = store.load([STREAM]);
    store.setTodos(STREAM, [TODO]);
    await expect(refresh).rejects.toThrow('Sidecar writes remain dirty');

    writeSpy.mockRestore();
    await store.flush();

    expect(await reloadWorkPlan()).toMatchObject({
      plan: PLAN,
      todos: [TODO],
    });
  });

  it('persists an eager overlay queued during a failed refresh', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValue(new Error('snapshot disk is full'));
    const output = outputFile('revised.tex', 1);

    store.setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    const refresh = store.load([STREAM]);
    store.addOutputFiles(STREAM, { 1: [output] });
    await expect(refresh).rejects.toThrow('Sidecar writes remain dirty');

    writeSpy.mockRestore();
    await store.flush();

    const reloaded = new StreamSnapshotStore();
    await reloaded.load([STREAM]);
    expect(reloaded.getOutputFiles(STREAM)).toEqual({ 1: [output] });
  });

  it('restores the authoritative seed after overlapping refreshes fail', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValue(new Error('snapshot disk is full'));

    store.setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    const firstRefresh = store.load([STREAM]);
    const secondRefresh = store.load([STREAM]);
    await Promise.all([
      expect(firstRefresh).rejects.toThrow('Sidecar writes remain dirty'),
      expect(secondRefresh).rejects.toThrow('Sidecar writes remain dirty'),
    ]);

    expect(store.getWorkPlan(STREAM).plan).toEqual(PLAN);
    store.setTodos(STREAM, [TODO]);
    writeSpy.mockRestore();
    await store.flush();

    expect(await reloadWorkPlan()).toMatchObject({
      plan: PLAN,
      todos: [TODO],
    });
  });

  it('does not recreate sidecars after deleting a stream with a failed write', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const writeError = new Error('snapshot disk is full');
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(writeError);

    store.setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    await store.deleteStream(STREAM);
    await store.flush();

    expect(await StorageFS.exists(streamDataDir(STREAM))).toBe(false);
  });

  it('keeps a newer staged mutation when an older write is dirty', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    const revisedPlan: Plan = { objective: 'Use the staged revision' };
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockRejectedValueOnce(new Error('snapshot disk is full'));

    store.setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    writeSpy.mockRestore();

    const staging = store.stageDeleteStream(STREAM);
    store.setPlan(STREAM, revisedPlan);
    const deletion = await staging;
    await deletion.rollback();
    await store.flush();

    expect((await reloadWorkPlan()).plan).toEqual(revisedPlan);
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
    // Corrupt-but-parseable payload must NOT throw and abort read()/resume.
    await writeStreamFile(STREAM, 'workPlan.json', {
      todos: 'not-an-array',
      plan: 42,
    });
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
  });

  it('ignores a workPlan.json stamped with a newer schemaVersion (forward-compat gate)', async () => {
    // A file from a FUTURE schema must be read as empty, not have its unknown
    // shape consumed as v1 (the single forward-compat gate).
    await writeStreamFile(STREAM, 'workPlan.json', {
      schemaVersion: 999,
      todos: [TODO],
      plan: PLAN,
      planSummary: PLAN_SUMMARY,
    });
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.todos).toEqual([]);
    expect(snap.plan).toBeNull();
  });

  it('drops a malformed executionId at the read entry without aborting the snapshot', async () => {
    // A legacy/corrupt executionId would trip the strict ExecutionIdSchema in
    // assembleSnapshot; validating at the read entry drops just the bad pointer
    // so the rest of meta (description) still surfaces and resume never throws.
    await writeStreamFile(STREAM, 'meta.json', {
      executionId: 'not-hex!!',
      description: 'Prior session',
    });
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
      await writeStreamFile(STREAM, 'legacyInstructions.json', {
        'run-1': { text: 'Polish the introduction', timestamp: 100 },
      });

      const legacy = await new StreamSnapshotStore().readLegacyInstruction(
        STREAM,
      );
      expect(legacy?.text).toBe('Polish the introduction');
    });

    it('falls back to the older runInstructions.json key, unmodified', async () => {
      const dir = streamDataDir(STREAM);
      await writeStreamFile(STREAM, 'runInstructions.json', {
        'run-1': { text: 'Rewrite the abstract' },
      });

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
      await writeStreamFile(STREAM, 'legacyInstructions.json', {
        older: { text: 'older instruction', timestamp: 100 },
        active: { text: 'active instruction', timestamp: 50 },
      });
      await writeStreamFile(STREAM, 'meta.json', { activeRunId: 'active' });

      const legacy = await new StreamSnapshotStore().readLegacyInstruction(
        STREAM,
      );
      expect(legacy?.text).toBe('active instruction');
    });
  });
});
