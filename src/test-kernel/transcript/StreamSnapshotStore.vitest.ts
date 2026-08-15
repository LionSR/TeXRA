import * as path from 'node:path';

import pDefer from 'p-defer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getExecutionStore } from '@agent/storage';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import * as logUtils from '@logger/logUtils';
import { resolveRunStoragePath } from '@platform/defaults/workspaceStorage';
import {
  STREAM_TAB_META_SCHEMA_VERSION,
  USER_FOLLOW_UP_SUPPORT,
  AgentCategory,
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
import {
  cleanupTempDirs,
  createTempDirPlatform,
} from '@test/support/tempDirPlatform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { snapshotFacts } from '@test/support/storeTestDrivers';
import { StreamSnapshotStore, streamDataDir } from '@transcript';
import {
  stagedStreamDataDir,
  STREAM_DATA_DIR,
  STREAM_DATA_DELETION_DIR,
} from '@transcript/streamDataPaths';
import { StorageFS } from '@utils/files/storageFS';

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
async function writeMetaFile(
  stream: StreamTabId,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeStreamFile(stream, 'meta.json', {
    schemaVersion: STREAM_TAB_META_SCHEMA_VERSION,
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
  snapshotFacts(store).setPlan(STREAM, PLAN);
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
  snapshotFacts(store).setPlan(STREAM, null);
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

    snapshotFacts(writer).setTodos(STREAM, [TODO]);
    snapshotFacts(writer).setPlan(STREAM, PLAN);
    // Two deltas for the same run must accumulate, not overwrite.
    void snapshotFacts(writer).addUsage(STREAM, RUN, usage(100, 20, 0.5));
    void snapshotFacts(writer).addUsage(STREAM, RUN, usage(50, 10, 0.25));

    await writer.flush();

    // A second store reads only from disk — the resume path.
    const reader = new StreamSnapshotStore();
    const snap = await reader.read(STREAM);

    expect(snap.todos).toEqual([TODO]);
    expect(snap.plan).toEqual(PLAN);
    expect(snap.planSummary).toBe(PLAN_SUMMARY);
    expect(snap.runUsage[RUN]).toMatchObject(usage(150, 30, 0.75));

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

    void snapshotFacts(writer).addUsage(STREAM, RUN, usage(100, 20, 0.5));
    // A delta with an uncoercible numeric field must not wipe out the
    // already-accumulated cost, and must warn rather than fail silently.
    void snapshotFacts(writer).addUsage(STREAM, RUN, {
      ...usage(50, 10, 0.25),
      inputTokens: 'not-a-number' as unknown as number,
    });

    await writer.flush();

    const reader = new StreamSnapshotStore();
    const snap = await reader.read(STREAM);
    expect(snap.runUsage[RUN]).toMatchObject(usage(100, 20, 0.5));
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamSnapshotStore',
      expect.stringContaining('Discarding malformed usage delta'),
      expect.anything(),
    );
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

    await getExecutionStore(executionId).writeRunRecord(runConfig);
    // Emitter contract for `updateStreamDescription` (#9590 A4/Stage 6): the
    // authority write to `ExecutionMeta.description` lands before the event.
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
      identity: { kind: 'agent', agent: 'session-label' },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
      description: 'session-search / kimi26T',
    });

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.start',
        streamId: STREAM,
        executionId,
        identity: { kind: 'agent', agent: 'session-label' },
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
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
    expect(snap.runUsage[RUN]).toMatchObject(usage(100, 20, 0.5));
    expect(snap.runUsage[RUN]).not.toHaveProperty('elapsedTime');
    expect(snap.runUsage[RUN]).not.toHaveProperty('percentageCached');
    // reasoningTokens is part of the accumulated vocabulary and persists.
    expect(snap.runUsage[RUN].reasoningTokens).toBe(7);
    expect(snap.runUsage[RUN]).not.toHaveProperty('toolUseTokens');
    expect(snap.executionId).toBe(executionId);
    // The live event updated the writer's display value in memory only.
    expect(writer.getRunMetadata(STREAM)).toMatchObject({
      description: 'session-search / kimi26T',
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    });
    // Every seed (bulk load included) hydrates the description from the one
    // authority, ExecutionMeta — it rides the same read as identity. Nothing
    // writes a sidecar copy, so the assembled snapshot carries none.
    expect(reader.getRunMetadata(STREAM)).toMatchObject({
      config: runConfig,
      description: 'session-search / kimi26T',
      identity: {
        kind: 'agent',
        agent: 'session-label',
      },
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.NATIVE_INTERACTIVE,
    });
    expect(snap.description).toBeUndefined();
    expect(snap.parentStreamId).toBe(OTHER_STREAM);

    const goalPausedOnly = await new StreamSnapshotStore().read(OTHER_STREAM);
    expect(goalPausedOnly.todos).toEqual([]);
    expect(goalPausedOnly.plan).toBeNull();
    expect(goalPausedOnly.runUsage).toEqual({});
  });

  it('keeps identity pending after run.config until run.start supplies it', async () => {
    const events = new SessionEventHub();
    const writer = new StreamSnapshotStore();
    const detach = writer.attachSessionEvents(events);
    const executionId = 'a1b2c3d4' as ExecutionId;
    const runConfig = toolUseConfig('worker-agent');
    const workflowIdentity = {
      kind: 'multiAgentWorkflow',
      workflowName: 'workflow-script',
    } as const;
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
      identity: workflowIdentity,
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
    // No synthesis from the config: identity stays pending until run.start.
    expect(writer.getRunMetadata(STREAM).identity).toBeUndefined();

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.start',
        streamId: STREAM,
        executionId,
        identity: workflowIdentity,
      },
    });
    detach();
    await writer.flush();

    expect(writer.getRunMetadata(STREAM).identity).toEqual(workflowIdentity);
    const reader = new StreamSnapshotStore();
    await reader.load([STREAM]);
    expect(reader.getRunMetadata(STREAM).executionId).toBe(executionId);
    expect(reader.getRunMetadata(STREAM).identity).toEqual(workflowIdentity);
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
  });

  it('seeds existing disk data before an unloaded usage mutation, so it is not erased', async () => {
    // A prior session persisted usage for run-1.
    await writeStreamFile(STREAM, 'usageStats.json', {
      'run-1': usage(100, 20, 0.5),
    });

    // A fresh store (NOT load()ed) handles a delta for a NEW run.
    const store = new StreamSnapshotStore();
    void snapshotFacts(store).addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    await store.flush();

    // run-1 (prior) survives — the unseeded write did not clobber it.
    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
    });
  });

  it('merges a mutation with on-disk sidecars for a stream outside the load() id set instead of clobbering them (#9956)', async () => {
    // A prior session persisted usage and a plan for STREAM.
    const previous = new StreamSnapshotStore();
    const previousFacts = snapshotFacts(previous);
    void previousFacts.addUsage(STREAM, RUN, usage(100, 20, 0.5));
    previousFacts.setPlan(STREAM, PLAN);
    await previous.flush();

    // An authoritative load whose id set does NOT contain STREAM (its
    // transcript is gone; the sidecar survives). A mutation for STREAM must
    // still seed from disk first; no global "I know the full stream set"
    // fact may stand in for this record's provenance.
    const store = new StreamSnapshotStore();
    await store.load([OTHER_STREAM]);
    void snapshotFacts(store).addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    await store.flush();

    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
    });
    expect((await reloadWorkPlan()).plan).toEqual(PLAN);
  });

  it('queues a mutation on a provenance-unknown stream behind its seed', async () => {
    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

    const store = new StreamSnapshotStore();
    await store.load([]);

    // Hold the seed's existence probe so the mutation cannot have persisted
    // before the seed resolved this record's disk state.
    const gate = pDefer<void>();
    const originalReadDir = StorageFS.readDir.bind(StorageFS);
    vi.spyOn(StorageFS, 'readDir').mockImplementation(async (target) => {
      if (target === streamDataDir(STREAM)) await gate.promise;
      return originalReadDir(target);
    });

    void snapshotFacts(store).addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    // Eagerly readable from memory while the seed is still gated...
    expect(store.getRunUsage(STREAM).get(RUN_2)).toMatchObject(
      usage(50, 10, 0.25),
    );
    // ...but nothing has touched the on-disk sidecar yet.
    expect(await readStreamFile(STREAM, 'usageStats.json')).toEqual({
      [RUN]: usage(100, 20, 0.5),
    });

    gate.resolve();
    await store.flush();

    expect(await readStreamFile(STREAM, 'usageStats.json')).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
    });
  });

  it('resolves a freshly minted stream to verified-absent and then mutates without consulting disk', async () => {
    const store = new StreamSnapshotStore();
    const facts = snapshotFacts(store);

    // First mutation: the seed's existence probe finds no sidecar directory,
    // so the record settles as 'verified-absent'.
    facts.setTodos(STREAM, [TODO]);
    await store.flush();
    expect(
      (await readStreamFile(STREAM, 'workPlan.json')) as object,
    ).toMatchObject({ todos: [TODO] });

    // Later mutations persist immediately from memory: no re-probe, no
    // sidecar re-read for this stream.
    const probeSpy = vi.spyOn(StorageFS, 'readDir');
    const readSpy = vi.spyOn(StorageFS, 'read');
    facts.setPlan(STREAM, PLAN);
    await store.flush();

    const streamDir = streamDataDir(STREAM);
    const touched = [...probeSpy.mock.calls, ...readSpy.mock.calls].filter(
      ([target]) => typeof target === 'string' && target.startsWith(streamDir),
    );
    expect(touched).toEqual([]);
    expect((await reloadWorkPlan()).plan).toEqual(PLAN);
    expect((await reloadWorkPlan()).todos).toEqual([TODO]);
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
    const pending = snapshotFacts(store).addUsage(
      STREAM,
      RUN_2,
      usage(50, 10, 0.25),
    );
    await Promise.resolve(pending);
    await store.flush();

    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();

    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
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
    snapshotFacts(store).addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    expect(store.getRunUsage(STREAM).get(RUN_2)).toMatchObject(
      usage(50, 10, 0.25),
    );
    await store.flush();

    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
    });
  });

  it('returns pre-seed usage only after a partial preload baseline is merged', async () => {
    await writeStreamFile(OTHER_STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    snapshotFacts(store).addUsage(OTHER_STREAM, RUN_2, usage(50, 10, 0.25));
    expect(store.getRunUsage(OTHER_STREAM).get(RUN_2)).toMatchObject(
      usage(50, 10, 0.25),
    );
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
    });
  });

  it('includes the disk baseline in a pre-seed usage result for the same run', async () => {
    await writeStreamFile(OTHER_STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    snapshotFacts(store).addUsage(OTHER_STREAM, RUN, usage(50, 10, 0.25));
    expect(store.getRunUsage(OTHER_STREAM).get(RUN)).toMatchObject(
      usage(50, 10, 0.25),
    );
    await store.flush();

    // After the seed merges the disk baseline, the typed view shows the sum.
    expect(store.getRunUsage(OTHER_STREAM).get(RUN)).toMatchObject(
      usage(150, 30, 0.75),
    );

    const raw = await readStreamFile(OTHER_STREAM, 'usageStats.json');
    expect(raw).toMatchObject({ [RUN]: usage(150, 30, 0.75) });
  });

  it('returns output files immediately for streams outside a partial preload without erasing disk outputs', async () => {
    const prior = outputFile('prior.tex', 0);
    const next = outputFile('next.tex', 1);
    await writeStreamFile(OTHER_STREAM, 'outputFiles.json', { '0': [prior] });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    snapshotFacts(store).addOutputFiles(OTHER_STREAM, { 1: [next] });
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

    snapshotFacts(store).updateMissingOutputs(OTHER_STREAM, {
      1: ['next.tex'],
    });
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

    snapshotFacts(store).updateMissingOutputs(STREAM, { 0: ['prior.tex'] });
    await store.flush();

    const malformedPatch = {
      0: ['replacement.tex'],
      1: ['invalid.tex', 42],
    } as unknown as RoundIndexed<string>;
    // The event plane contains subscriber errors: the malformed patch is
    // rejected inside the store and logged by the hub, never applied.
    snapshotFacts(store).updateMissingOutputs(STREAM, malformedPatch);

    expect(store.getMissingOutputs(STREAM)).toEqual({ 0: ['prior.tex'] });
    await store.flush();
    expect(await readStreamFile(STREAM, 'missingOutputs.json')).toEqual({
      '0': ['prior.tex'],
    });

    snapshotFacts(store).updateMissingOutputs(STREAM, { 1: ['next.tex'] });
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

    snapshotFacts(store).clearMissingOutputs(OTHER_STREAM);
    snapshotFacts(store).updateMissingOutputs(OTHER_STREAM, {
      1: ['next.tex'],
    });
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

    snapshotFacts(store).updateMissingOutputs(OTHER_STREAM, {
      1: ['next.tex'],
    });
    snapshotFacts(store).clearMissingOutputs(OTHER_STREAM);
    expect(store.getMissingOutputs(OTHER_STREAM)).toEqual({});
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'missingOutputs.json');
    expect(raw).toEqual({});
  });

  it('clears missing outputs only on the exactly addressed stream, even with duplicate run configurations (#9590 A3)', async () => {
    const events = new SessionEventHub();
    const store = new StreamSnapshotStore();
    const detach = store.attachSessionEvents(events);
    // Two look-alike tabs: identical agent/model/input configuration. Only
    // the initiator-selected StreamTabId may be mutated.
    const duplicateConfig = AgentConfigSchema.parse({
      agent: 'correct',
      model: 'deepseekT',
      agentCategory: AgentCategory.Workflow,
      inputFiles: ['paper.tex'],
    });
    const executions: Record<string, ExecutionId> = {
      [STREAM]: 'a1b2c3d4' as ExecutionId,
      [OTHER_STREAM]: 'd4c3b2a1' as ExecutionId,
    };
    for (const stream of [STREAM, OTHER_STREAM]) {
      events.emit({
        scope: 'run',
        streamId: stream,
        event: {
          type: 'run.config',
          streamId: stream,
          executionId: executions[stream],
          config: duplicateConfig,
        },
      });
      events.emit({
        scope: 'run',
        streamId: stream,
        event: {
          type: 'updateMissingOutputs',
          streamId: stream,
          filesByRound: { 1: ['missing.tex'] },
        },
      });
    }

    // Exact addressing clears the selected stream alone; the duplicate
    // configuration on the other tab does not authorize a fan-out.
    events.emit({
      scope: 'session',
      event: {
        type: 'clearMissingOutputs',
        payload: { streamId: STREAM },
      },
    });
    expect(store.getMissingOutputs(STREAM)).toEqual({});
    expect(store.getMissingOutputs(OTHER_STREAM)).toEqual({
      1: ['missing.tex'],
    });
    detach();
    // Settle the async sidecar writes before afterEach removes the temp dir.
    await store.flush();
  });

  it('returns compile failures immediately for streams outside a partial preload without erasing disk markers', async () => {
    const prior = compileFailure('prior.tex', 0);
    const next = compileFailure('next.tex', 1);
    await writeStreamFile(OTHER_STREAM, 'compileFailures.json', {
      '0': [prior],
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    snapshotFacts(store).updateCompileFailures(OTHER_STREAM, { 1: [next] });
    // Eagerly applied for the same reason as the missing-outputs case above.
    expect(store.getCompileFailures(OTHER_STREAM)[1]).toEqual([next]);
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'compileFailures.json');
    expect(raw).toMatchObject({
      '0': [prior],
      '1': [next],
    });
  });

  it('returns work-plan updates immediately for streams outside a partial preload without erasing disk plans', async () => {
    const priorPlan: Plan = { objective: 'Prior durable objective.' };
    await writeStreamFile(OTHER_STREAM, 'workPlan.json', {
      schemaVersion: 1,
      todos: [TODO],
      plan: priorPlan,
      planSummary: 'Prior durable objective.',
    });

    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    const liveTodo: TodoItem = {
      content: 'Live todo',
      status: 'in_progress',
      activeForm: 'Working the live todo',
    };
    snapshotFacts(store).setPlan(OTHER_STREAM, PLAN);
    snapshotFacts(store).setTodos(OTHER_STREAM, [liveTodo]);
    // Eager overlay so hydrate/preload cannot clobber live TUI plan state.
    expect(store.getWorkPlan(OTHER_STREAM)).toMatchObject({
      plan: PLAN,
      todos: [liveTodo],
    });
    await store.flush();

    const raw = await readStreamFile(OTHER_STREAM, 'workPlan.json');
    expect(raw).toMatchObject({
      plan: PLAN,
      todos: [liveTodo],
    });
  });

  it('makes task state readable immediately while preserving later seeded sidecars', async () => {
    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(100, 20, 0.5),
    });

    const store = new StreamSnapshotStore();
    const runConfig = toolUseConfig();
    const executionId = 'abc123' as ExecutionId;

    snapshotFacts(store).setRunConfig(STREAM, runConfig, executionId);
    expect(store.getRunMetadata(STREAM).config).toEqual(runConfig);
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);
    snapshotFacts(store).addUsage(STREAM, RUN_2, usage(50, 10, 0.25));
    expect(store.getRunUsage(STREAM).get(RUN_2)).toMatchObject(
      usage(50, 10, 0.25),
    );
    await store.flush();

    expect(store.getRunMetadata(STREAM).config).toEqual(runConfig);
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);
    const raw = await readStreamFile(STREAM, 'usageStats.json');
    expect(raw).toMatchObject({
      [RUN]: usage(100, 20, 0.5),
      [RUN_2]: usage(50, 10, 0.25),
    });
  });

  it('rejects unsupported meta schemas before writing a current record', async () => {
    await installPlatform();
    await writeStreamFile(STREAM, 'meta.json', {
      schemaVersion: 0,
      description: 'Unsupported stale session',
    });

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunMetadata(STREAM).description).toBeUndefined();

    snapshotFacts(store).setParentStream(STREAM, OTHER_STREAM);
    await store.flush();

    const raw = (await readStreamFile(STREAM, 'meta.json')) as {
      schemaVersion?: unknown;
      parentStreamId?: unknown;
      description?: unknown;
    };
    expect(raw.schemaVersion).toBe(STREAM_TAB_META_SCHEMA_VERSION);
    expect(raw.parentStreamId).toBe(OTHER_STREAM);
    // The rejected file's fields do not leak into the fresh current record.
    expect(raw.description).toBeUndefined();
  });

  it('leaves the run config absent when an execution config is unreadable', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    await writeMetaFile(STREAM, { executionId });
    await StorageFS.ensureDir(resolveRunStoragePath(executionId));
    await StorageFS.write(
      path.join(resolveRunStoragePath(executionId), 'config.json'),
      '{',
    );

    // The legacy `meta.taskState` fallback is retired: an unreadable execution
    // config leaves the stream with no config at all, not a shimmed one.
    const store = new StreamSnapshotStore();
    await expect(store.load([STREAM])).resolves.toBeUndefined();

    expect(store.getRunMetadata(STREAM).config).toBeUndefined();
    expect(store.getRunMetadata(STREAM).identity).toBeUndefined();
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);
  });

  it('strips a retired runDescriptor sidecar without reading its FK', async () => {
    // Pre-FK sidecars carried a whole runDescriptor; that shape is retired.
    // The unknown key is stripped: no FK is lifted out of it, and the rest
    // of the meta (parentStreamId) survives untouched.
    await writeMetaFile(STREAM, {
      parentStreamId: OTHER_STREAM,
      runDescriptor: {
        schemaVersion: 1,
        streamId: STREAM,
        executionId: 'aa11bb22',
        agent: 'legacy-search',
        category: AgentCategory.ToolUse,
        kind: 'agent',
      },
    });

    const store = new StreamSnapshotStore();
    expect(await store.readPersistedExecutionId(STREAM)).toBeUndefined();
    await store.load([STREAM]);

    expect(store.getRunMetadata(STREAM).executionId).toBeUndefined();
    await expect(store.read(STREAM)).resolves.toMatchObject({
      executionId: undefined,
      parentStreamId: OTHER_STREAM,
    });
  });

  it('drops only a malformed execution FK from meta, loudly', async () => {
    // Field-level tolerance: a malformed FK severs the execution pointer
    // (warned), but must NOT discard the rest of the meta — losing
    // `parentStreamId` would orphan the tab.
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    await writeMetaFile(STREAM, {
      parentStreamId: OTHER_STREAM,
      executionId: 'not-hex!!',
    });

    const store = new StreamSnapshotStore();
    await expect(store.read(STREAM)).resolves.toMatchObject({
      executionId: undefined,
      parentStreamId: OTHER_STREAM,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamSnapshotStore',
      expect.stringContaining('malformed execution FK'),
      expect.anything(),
    );
  });

  it('warns and rejects malformed outer stream metadata', async () => {
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    await writeStreamFile(STREAM, 'meta.json', ['not', 'stream', 'metadata']);

    const snapshot = await new StreamSnapshotStore().read(STREAM);

    expect(snapshot.executionId).toBeUndefined();
    expect(snapshot.parentStreamId).toBeUndefined();
    expect(snapshot.description).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamSnapshotStore',
      expect.stringContaining('unreadable persisted stream metadata'),
      expect.anything(),
    );
  });

  it('does not apply an authority read across an execution handoff', async () => {
    await installPlatform();
    const oldExecutionId = 'ee66aa77' as ExecutionId;
    const newExecutionId = 'ff77bb88' as ExecutionId;
    const oldExecutionStore = getExecutionStore(oldExecutionId);
    await oldExecutionStore.writeRunRecord(toolUseConfig('old-search'));
    await oldExecutionStore.writeMeta({
      timestamp: new Date(0).toISOString(),
      description: 'Old authority label',
    });
    await writeMetaFile(STREAM, { executionId: oldExecutionId });
    const oldMeta = await oldExecutionStore.readMeta();
    const readStarted = pDefer<void>();
    const deferredRead = pDefer<typeof oldMeta>();
    vi.spyOn(oldExecutionStore, 'readMeta').mockImplementation(() => {
      readStarted.resolve();
      return deferredRead.promise;
    });

    const store = new StreamSnapshotStore();
    const facts = snapshotFacts(store);
    const loading = store.load([STREAM]);
    await readStarted.promise;
    const newIdentity = { kind: 'agent', agent: 'new-search' } as const;
    facts.setRunStart({
      streamId: STREAM,
      executionId: newExecutionId,
      identity: newIdentity,
    });
    deferredRead.resolve(oldMeta);
    await loading;

    expect(store.getRunMetadata(STREAM).identity).toEqual(newIdentity);
    expect(store.getRunMetadata(STREAM).description).toBeUndefined();
  });

  it('does not overwrite a live description that lands during hydration', async () => {
    await installPlatform();
    const executionId = 'aa77cc88' as ExecutionId;
    const executionStore = getExecutionStore(executionId);
    await executionStore.writeRunRecord(toolUseConfig());
    await executionStore.writeMeta({
      timestamp: new Date(0).toISOString(),
      description: 'Captured authority label',
    });
    await writeMetaFile(STREAM, { executionId });
    const capturedMeta = await executionStore.readMeta();
    const readStarted = pDefer<void>();
    const deferredRead = pDefer<typeof capturedMeta>();
    // The description rides the seed's one execution-meta read; the live
    // event lands while that read is still in flight.
    vi.spyOn(executionStore, 'readMeta').mockImplementation(() => {
      readStarted.resolve();
      return deferredRead.promise;
    });

    const store = new StreamSnapshotStore();
    const facts = snapshotFacts(store);
    // First mutation on the unseeded stream triggers the lazy seed, whose
    // hydration would otherwise fill the description from ExecutionMeta.
    facts.setParentStream(STREAM, OTHER_STREAM);
    const flushing = store.flush();
    await readStarted.promise;
    facts.setDescription(STREAM, 'New live label');
    deferredRead.resolve(capturedMeta);
    await flushing;

    // The live event owns the field by presence; hydration does not clobber it.
    expect(store.getRunMetadata(STREAM).description).toBe('New live label');
  });

  it('hydrates a current no-mirror description during first lazy seed', async () => {
    await installPlatform();
    const executionId = 'bb88dd99' as ExecutionId;
    await getExecutionStore(executionId).writeRunRecord(toolUseConfig());
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
      description: 'Lazy authority label',
    });
    await writeMetaFile(STREAM, { executionId });

    const store = new StreamSnapshotStore();
    snapshotFacts(store).setParentStream(STREAM, OTHER_STREAM);
    await store.flush();

    expect(store.getRunMetadata(STREAM).description).toBe(
      'Lazy authority label',
    );
    expect(
      ((await readStreamFile(STREAM, 'meta.json')) as { description?: unknown })
        .description,
    ).toBeUndefined();
  });

  it("round-trips a current record's description through ExecutionMeta only (#9590 Stage 6)", async () => {
    await installPlatform();
    const events = new SessionEventHub();
    const store = new StreamSnapshotStore();
    const detach = store.attachSessionEvents(events);
    const executionId = 'aa55ff66' as ExecutionId;
    const runConfig = toolUseConfig();
    await getExecutionStore(executionId).writeRunRecord(runConfig);

    events.emit({
      scope: 'run',
      streamId: STREAM,
      event: {
        type: 'run.start',
        streamId: STREAM,
        executionId,
        identity: { kind: 'agent', agent: 'search' },
      },
    });
    // Emitter contract (#9590 A4): the authority write to
    // `ExecutionMeta.description` lands before the display event is emitted.
    await getExecutionStore(executionId).writeMeta({
      timestamp: new Date(0).toISOString(),
      description: 'Current label',
    });
    events.emit({
      scope: 'session',
      event: {
        type: 'updateStreamDescription',
        payload: { streamId: STREAM, description: 'Current label' },
      },
    });
    expect(store.getRunMetadata(STREAM).description).toBe('Current label');
    detach();
    await store.flush();

    // Persistence boundary: the sidecar meta carries the execution FK but no
    // description copy — the sidecar write stopped in Stage 6.
    const raw = (await readStreamFile(STREAM, 'meta.json')) as {
      executionId?: unknown;
      description?: unknown;
    };
    expect(raw.executionId).toBe(executionId);
    expect(raw.description).toBeUndefined();

    // A fresh store reads the description back via the FK → ExecutionMeta on
    // the stream's first lazy seed (a bulk load() does not hydrate it).
    const reloaded = new StreamSnapshotStore();
    snapshotFacts(reloaded).setParentStream(STREAM, OTHER_STREAM);
    await reloaded.flush();
    expect(reloaded.getRunMetadata(STREAM).description).toBe('Current label');

    // The label is execution-scoped: a live run.start handing the stream to a
    // new execution synchronously drops the previous run's description.
    snapshotFacts(reloaded).setRunStart({
      streamId: STREAM,
      executionId: 'bb77bb88' as ExecutionId,
      identity: { kind: 'agent', agent: 'search' },
    });
    expect(reloaded.getRunMetadata(STREAM).description).toBeUndefined();
  });

  it('keeps a runtime run-config update that arrives during async hydration', async () => {
    await installPlatform();
    const oldExecutionId = 'abc123' as ExecutionId;
    const newExecutionId = 'def456' as ExecutionId;
    const oldConfig = toolUseConfig('old-search');
    const newConfig = toolUseConfig('new-search');
    await writeMetaFile(STREAM, { executionId: oldExecutionId });
    await getExecutionStore(oldExecutionId).writeRunRecord(oldConfig);

    const store = new StreamSnapshotStore();
    const wasRuntimeUpdateInjected = injectDuringExecutionConfigHydration(
      oldExecutionId,
      () =>
        snapshotFacts(store).setRunConfig(STREAM, newConfig, newExecutionId),
    );

    await store.load([STREAM]);
    expect(wasRuntimeUpdateInjected).toHaveBeenCalledOnce();
    expect(store.getRunMetadata(STREAM).config).toEqual(newConfig);
    expect(store.getRunMetadata(STREAM).executionId).toBe(newExecutionId);

    await store.flush();
    const raw = (await readStreamFile(STREAM, 'meta.json')) as {
      executionId?: unknown;
      runDescriptor?: unknown;
    };
    expect(raw.executionId).toBe(newExecutionId);
    expect(raw.runDescriptor).toBeUndefined();
  });

  it('keeps a same-execution model switch that arrives during async hydration', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    const persisted = toolUseConfig('search', 'deepseekproT');
    const switched = toolUseConfig('search', 'kimi26T');
    await writeMetaFile(STREAM, { executionId });
    await getExecutionStore(executionId).writeRunRecord(persisted);

    const store = new StreamSnapshotStore();
    // A model switch rewrites the execution config and re-emits `run.config`
    // for the SAME execution, so the identity check cannot tell the two apart:
    // the live event wins because the seed only fills what it did not receive.
    const wasModelSwitchInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => snapshotFacts(store).setRunConfig(STREAM, switched, executionId),
    );

    await store.load([STREAM]);

    expect(wasModelSwitchInjected).toHaveBeenCalledOnce();
    expect(store.getRunMetadata(STREAM).config?.model).toBe('kimi26T');
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);
  });

  it('does not re-derive the run.start identity when a seed re-reads disk meta', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    const runConfig = toolUseConfig('worker-agent');
    const workflowIdentity = {
      kind: 'multiAgentWorkflow',
      workflowName: 'workflow-script',
    } as const;
    await getExecutionStore(executionId).writeRunRecord(runConfig);

    const store = new StreamSnapshotStore();
    snapshotFacts(store).setRunStart({
      streamId: STREAM,
      executionId,
      identity: workflowIdentity,
    });
    snapshotFacts(store).setRunConfig(STREAM, runConfig, executionId);
    await store.flush();

    // Disk meta names the same execution but carries no identity of its own.
    // Re-seeding may read it, but may not synthesize a competing identity
    // from the execution config over the one run.start emitted.
    await writeMetaFile(STREAM, { executionId });
    await store.load([STREAM]);

    expect(store.getRunMetadata(STREAM).identity).toEqual(workflowIdentity);
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);
  });

  it('adopts run identity from disk when meta names a different execution', async () => {
    await installPlatform();
    const liveExecutionId = 'abc123' as ExecutionId;
    const foreignExecutionId = 'def456' as ExecutionId;
    const foreignConfig = toolUseConfig('foreign-search');

    const store = new StreamSnapshotStore();
    snapshotFacts(store).setRunConfig(
      STREAM,
      toolUseConfig('live-search'),
      liveExecutionId,
    );
    await store.flush();

    await getExecutionStore(foreignExecutionId).writeRunRecord(foreignConfig);
    await getExecutionStore(foreignExecutionId).writeMeta({
      timestamp: new Date(0).toISOString(),
      identity: { kind: 'agent', agent: 'foreign-search' },
    });
    await writeMetaFile(STREAM, { executionId: foreignExecutionId });
    await store.load([STREAM]);

    expect(store.getRunMetadata(STREAM).executionId).toBe(foreignExecutionId);
    expect(store.getRunMetadata(STREAM).config).toEqual(foreignConfig);
    expect(store.getRunMetadata(STREAM).identity).toEqual({
      kind: 'agent',
      agent: 'foreign-search',
    });
  });

  it('refreshes the run config from disk when another host switched the model', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    await writeMetaFile(STREAM, { executionId });
    await getExecutionStore(executionId).writeRunRecord(
      toolUseConfig('search', 'deepseekproT'),
    );

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunMetadata(STREAM).config?.model).toBe('deepseekproT');

    // The model switch runs in another host: it rewrites the execution config
    // for the SAME execution and this store never sees the `run.config` event.
    await getExecutionStore(executionId).writeRunRecord(
      toolUseConfig('search', 'kimi26T'),
    );
    await store.load([STREAM]);

    expect(store.getRunMetadata(STREAM).config?.model).toBe('kimi26T');
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);
  });

  it('returns a fresh immutable outer run-metadata record', () => {
    const store = new StreamSnapshotStore();

    const first = store.getRunMetadata(STREAM);
    const second = store.getRunMetadata(STREAM);

    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('drops run identity when disk meta no longer names an execution', async () => {
    await installPlatform();
    const executionId = 'abc123' as ExecutionId;
    await writeMetaFile(STREAM, { executionId });
    await getExecutionStore(executionId).writeRunRecord(toolUseConfig());

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunMetadata(STREAM).executionId).toBe(executionId);

    await writeMetaFile(STREAM, {});
    await store.load([STREAM]);

    expect(store.getRunMetadata(STREAM).identity).toBeUndefined();
    expect(store.getRunMetadata(STREAM).config).toBeUndefined();
    expect(store.getRunMetadata(STREAM).executionId).toBeUndefined();
    expect(store.getRunMetadata(STREAM).description).toBeUndefined();
  });

  it('does not attach the seeded run config to a run.start that lands during hydration', async () => {
    await installPlatform();
    const oldExecutionId = 'abc123' as ExecutionId;
    const newExecutionId = 'def456' as ExecutionId;
    const oldConfig = toolUseConfig('old-search');
    await writeMetaFile(STREAM, { executionId: oldExecutionId });
    await getExecutionStore(oldExecutionId).writeRunRecord(oldConfig);

    const store = new StreamSnapshotStore();
    await store.load([STREAM]);
    expect(store.getRunMetadata(STREAM).config).toEqual(oldConfig);

    const newIdentity = {
      kind: 'multiAgentWorkflow',
      workflowName: 'workflow-script',
    } as const;
    // `run.start` for the next execution lands while the seed is still reading
    // the previous one's config, which belongs to neither the new identity nor
    // this stream any more.
    const wasRunStartInjected = injectDuringExecutionConfigHydration(
      oldExecutionId,
      () =>
        snapshotFacts(store).setRunStart({
          streamId: STREAM,
          executionId: newExecutionId,
          identity: newIdentity,
        }),
    );
    await store.load([STREAM]);

    expect(wasRunStartInjected).toHaveBeenCalledOnce();
    expect(store.getRunMetadata(STREAM).identity).toEqual(newIdentity);
    expect(store.getRunMetadata(STREAM).config).toBeUndefined();
  });

  it('persists a late reset and round patch that arrive during async hydration', async () => {
    await installPlatform();
    const executionId = 'c0ffee' as ExecutionId;
    await Promise.all([
      writeMetaFile(STREAM, { executionId }),
      writeStreamFile(STREAM, 'missingOutputs.json', { '0': ['stale.tex'] }),
      getExecutionStore(executionId).writeRunRecord(toolUseConfig()),
    ]);

    const store = new StreamSnapshotStore();
    const wereLateOverlaysInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => {
        snapshotFacts(store).clearMissingOutputs(STREAM);
        snapshotFacts(store).updateMissingOutputs(STREAM, { 1: ['late.tex'] });
        void snapshotFacts(store).addUsage(STREAM, RUN, usage(10, 2, 0.1));
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
      writeMetaFile(STREAM, { executionId }),
      writeStreamFile(STREAM, 'missingOutputs.json', {
        '0': ['current.tex'],
      }),
      getExecutionStore(executionId).writeRunRecord(toolUseConfig()),
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
    expect(store.getRunUsage(STREAM).get(RUN)).toMatchObject(
      usage(100, 20, 0.5),
    );

    await writeStreamFile(STREAM, 'usageStats.json', {
      [RUN]: usage(3, 4, 0.01),
    });
    await store.load([STREAM]);

    expect(store.getRunUsage(STREAM).get(RUN)).toMatchObject(usage(3, 4, 0.01));
  });

  it('treats streams created after load as new so direct mutators stay synchronous', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);

    snapshotFacts(store).setTodos(STREAM, [TODO]);
    snapshotFacts(store).setPlan(STREAM, PLAN);

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

    snapshotFacts(store).addUsage(STREAM, RUN, usage(1, 2, 0.03));
    await store.deleteStream(STREAM);

    expect(await StorageFS.exists(dir)).toBe(false);
  });

  it('keeps the complete snapshot when atomic staging fails', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    snapshotFacts(store).setTodos(STREAM, [TODO]);
    snapshotFacts(store).setPlan(STREAM, PLAN);
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
    snapshotFacts(store).setTodos(STREAM, [TODO]);
    snapshotFacts(store).setPlan(STREAM, PLAN);
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
    snapshotFacts(store).setPlan(STREAM, null);
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
    // A write landing while rollback replays the buffered clear must be
    // drained by the same rollback instead of leaking past it. Inject through
    // the write seam the replay drains into: when the replayed workPlan write
    // reaches disk, a newer todo arrives and is diverted into the staged
    // deletion's buffer, forcing a second replay pass.
    const writeAtomic = StorageFS.writeAtomic.bind(StorageFS);
    const streamPlanPath = path.join(streamDataDir(STREAM), 'workPlan.json');
    let injected = false;
    const writeSpy = vi
      .spyOn(StorageFS, 'writeAtomic')
      .mockImplementation(async (target, data) => {
        await writeAtomic(target, data);
        if (!injected && target === streamPlanPath) {
          injected = true;
          snapshotFacts(store).setTodos(STREAM, [TODO]);
        }
      });

    await deletion.rollback();

    writeSpy.mockRestore();
    expect(await reloadWorkPlan()).toMatchObject({
      plan: null,
      todos: [TODO],
    });
    await store.deleteStream(STREAM);
  });

  it('serializes overlapping staged deletions for one stream', async () => {
    const store = await storeWithPersistedPlan();

    const firstDeletion = await store.stageDeleteStream(STREAM);
    snapshotFacts(store).setPlan(STREAM, null);
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
    snapshotFacts(store).setPlan(STREAM, revisedPlan);
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
    snapshotFacts(store).setPlan(OTHER_STREAM, PLAN);
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
        snapshotFacts(store).setPlan(STREAM, null);
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

    snapshotFacts(store).setPlan(STREAM, null);
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

  it('retains refresh authority when initial deletion staging inspection fails', async () => {
    const store = await storeWithPersistedPlan();
    const refreshReadStarted = pDefer<void>();
    const continueRefresh = pDefer<void>();
    const workPlanPath = path.join(streamDataDir(STREAM), 'workPlan.json');
    const read = StorageFS.read.bind(StorageFS);
    const readSpy = vi
      .spyOn(StorageFS, 'read')
      .mockImplementation(async (...args) => {
        if (args[0] === workPlanPath) {
          refreshReadStarted.resolve();
          await continueRefresh.promise;
        }
        return read(...args);
      });

    const refresh = store.load([STREAM]);
    await refreshReadStarted.promise;

    const setupError = new Error('cannot inspect staged snapshot');
    const stat = StorageFS.stat.bind(StorageFS);
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockRejectedValueOnce(setupError)
      .mockImplementation(stat);

    const staging = store.stageDeleteStream(STREAM);
    await vi.waitFor(() => expect(statSpy).toHaveBeenCalledOnce());
    continueRefresh.resolve();
    await expect(staging).rejects.toBe(setupError);
    await refresh;

    statSpy.mockRestore();
    readSpy.mockRestore();
    expect(store.getWorkPlan(STREAM).plan).toEqual(PLAN);
    snapshotFacts(store).setTodos(STREAM, [TODO]);
    await store.flush();

    expect(await reloadWorkPlan()).toMatchObject({
      plan: PLAN,
      todos: [TODO],
    });
  });

  it('keeps writes buffered when a staging rename fails after moving data', async () => {
    const store = await storeWithPersistedPlan();
    const renameError = new Error('snapshot rename acknowledgement failed');
    const rename = StorageFS.rename.bind(StorageFS);
    const renameSpy = vi
      .spyOn(StorageFS, 'rename')
      .mockImplementationOnce(async (source, destination) => {
        snapshotFacts(store).setPlan(STREAM, null);
        await rename(source, destination);
        throw renameError;
      })
      .mockImplementation(rename);

    await expect(store.stageDeleteStream(STREAM)).rejects.toBe(renameError);

    snapshotFacts(store).setPlan(STREAM, PLAN);
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
    snapshotFacts(store).setTodos(STREAM, [TODO]);
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
    snapshotFacts(store).setTodos(STREAM, [TODO]);
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
        snapshotFacts(store).setTodos(STREAM, [TODO]);
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
    snapshotFacts(store).setPlan(STREAM, PLAN);
    void snapshotFacts(store).addUsage(STREAM, RUN, usage(100, 20, 0.5));
    await store.flush();
    const deletion = await store.stageDeleteStream(STREAM);
    snapshotFacts(store).setPlan(STREAM, null);
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
    expect(reloaded.runUsage[RUN]).toMatchObject(usage(100, 20, 0.5));
    await store.deleteStream(STREAM);
  });

  it('discards staged residue when failed rollback data has a live base', async () => {
    const store = new StreamSnapshotStore();
    await store.load([]);
    snapshotFacts(store).setPlan(STREAM, PLAN);
    void snapshotFacts(store).addUsage(STREAM, RUN, usage(100, 20, 0.5));
    await store.flush();
    const deletion = await store.stageDeleteStream(STREAM);
    snapshotFacts(store).setPlan(STREAM, null);
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
    expect(reloaded.runUsage[RUN]).toMatchObject(usage(100, 20, 0.5));
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
        snapshotFacts(store).setPlan(STREAM, null);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
    await initialWriteStart;
    const setupError = new Error('cannot inspect staged snapshot');
    const stat = StorageFS.stat.bind(StorageFS);
    const statSpy = vi
      .spyOn(StorageFS, 'stat')
      .mockImplementationOnce(async () => {
        snapshotFacts(store).setPlan(STREAM, null);
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
    snapshotFacts(writer).setRunConfig(STREAM, toolUseConfig(), executionId);
    snapshotFacts(writer).setPlan(STREAM, PLAN);
    await writer.flush();
    await getExecutionStore(executionId).writeRunRecord(toolUseConfig());

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
    snapshotFacts(store).setTodos(STREAM, [TODO]);
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
      writeMetaFile(STREAM, { executionId }),
      writeStreamFile(STREAM, 'missingOutputs.json', { '0': ['stale.tex'] }),
      getExecutionStore(executionId).writeRunRecord(toolUseConfig()),
    ]);

    const store = new StreamSnapshotStore();
    let deletion: Promise<void> | undefined;
    const wasDeleteInjected = injectDuringExecutionConfigHydration(
      executionId,
      () => {
        snapshotFacts(store).updateMissingOutputs(STREAM, { 1: ['late.tex'] });
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
    snapshotFacts(store).setPlan(STREAM, revisedPlan);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    const refresh = store.load([STREAM]);
    snapshotFacts(store).setTodos(STREAM, [TODO]);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    const refresh = store.load([STREAM]);
    snapshotFacts(store).addOutputFiles(STREAM, { 1: [output] });
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    const firstRefresh = store.load([STREAM]);
    const secondRefresh = store.load([STREAM]);
    await Promise.all([
      expect(firstRefresh).rejects.toThrow('Sidecar writes remain dirty'),
      expect(secondRefresh).rejects.toThrow('Sidecar writes remain dirty'),
    ]);

    expect(store.getWorkPlan(STREAM).plan).toEqual(PLAN);
    snapshotFacts(store).setTodos(STREAM, [TODO]);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
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

    snapshotFacts(store).setPlan(STREAM, PLAN);
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    writeSpy.mockRestore();

    const staging = store.stageDeleteStream(STREAM);
    snapshotFacts(store).setPlan(STREAM, revisedPlan);
    const deletion = await staging;
    await deletion.rollback();
    await store.flush();

    expect((await reloadWorkPlan()).plan).toEqual(revisedPlan);
  });

  it('serializes same-key writes so a slow first write finishes before a queued second write starts', async () => {
    const store = new StreamSnapshotStore();
    // Seed STREAM so its provenance is settled ('verified-absent') and each
    // mutation below persists synchronously as its own same-key write.
    await store.load([STREAM]);

    const order: string[] = [];
    let releaseFirstWrite: () => void = () => {};
    const firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    let writeCount = 0;
    vi.spyOn(StorageFS, 'writeAtomic').mockImplementation(async () => {
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
    snapshotFacts(store).setTodos(STREAM, [TODO]);
    snapshotFacts(store).setPlan(STREAM, PLAN);

    // Let the first queued write actually begin before releasing it, so the
    // assertion below reflects genuine serialization, not incidental timing.
    await vi.waitFor(() => {
      expect(order).toEqual(['first-start']);
    });

    releaseFirstWrite();
    await store.flush();

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
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

  it('drops a malformed executionId loudly without aborting the snapshot', async () => {
    // A legacy/corrupt executionId fails StreamTabMetaSchema; only the bad
    // FK is dropped (warned, not silently coerced) and the snapshot read
    // still succeeds with a valid record.
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    await writeStreamFile(STREAM, 'meta.json', {
      executionId: 'not-hex!!',
      description: 'Prior session',
    });
    const snap = await new StreamSnapshotStore().read(STREAM);
    expect(snap.executionId).toBeUndefined();
    expect(snap.description).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      'StreamSnapshotStore',
      expect.stringContaining('malformed execution FK'),
      expect.anything(),
    );
  });
});

describe('StreamSnapshotStore loud unhydrated access (#9947)', () => {
  setupPlatform(() => createTempDirPlatform('texra-snapshot-', tempDirs));

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  function unseededWarnings(warnSpy: {
    mock: { calls: unknown[][] };
  }): string[] {
    return warnSpy.mock.calls
      .map(([, message]) => String(message))
      .filter((message) => message.includes('unestablished disk provenance'));
  }

  it('warns once per accessor and stream while still serving the default', async () => {
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = new StreamSnapshotStore();

    // The loud default: callers still get the empty shape, but the read is
    // reported instead of silently degrading.
    expect(store.getRunMetadata(STREAM).executionId).toBeUndefined();
    expect(store.getOutputFiles(STREAM)).toEqual({});
    expect(store.getWorkPlan(STREAM).todos).toEqual([]);
    // Repeats do not spam.
    store.getRunMetadata(STREAM);
    store.getOutputFiles(STREAM);
    // A different stream warns separately.
    store.getRunMetadata(OTHER_STREAM);

    const warnings = unseededWarnings(warnSpy);
    expect(warnings).toHaveLength(4);
    expect(warnings[0]).toContain('getRunMetadata');
    expect(warnings[0]).toContain(STREAM);
    expect(warnings[1]).toContain('getOutputFiles');
    expect(warnings[2]).toContain('getWorkPlan');
    expect(warnings[3]).toContain(OTHER_STREAM);
  });

  it('stays quiet once disk provenance is established', async () => {
    const warnSpy = vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = new StreamSnapshotStore();
    await store.preload([STREAM]);

    store.getRunMetadata(STREAM);
    store.getOutputFiles(STREAM);
    store.getWorkPlan(STREAM);
    store.getParentStreamId(STREAM);

    expect(unseededWarnings(warnSpy)).toHaveLength(0);
  });

  it('publishes whole metadata objects to the summary sink on run facts and hydration', async () => {
    vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const store = new StreamSnapshotStore();
    const seen: { stream: string; meta: Record<string, unknown> }[] = [];
    store.attachSessionEvents(new SessionEventHub(), {
      summaryMetaSink: (stream, meta) => seen.push({ stream, meta }),
    });

    snapshotFacts(store).setRunStart({
      streamId: STREAM,
      executionId: 'a77e77' as ExecutionId,
      identity: { kind: 'agent', agent: 'search' },
    });
    snapshotFacts(store).setRunConfig(
      STREAM,
      toolUseConfig('search', 'deepseekproT'),
      'a77e77' as ExecutionId,
    );

    const last = seen.at(-1);
    expect(last?.stream).toBe(STREAM);
    expect(last?.meta).toMatchObject({
      identity: { kind: 'agent', agent: 'search' },
      executionId: 'a77e77',
      agentCategory: AgentCategory.ToolUse,
      model: 'deepseekproT',
    });

    // Hydration republishes (the lazy backfill path for legacy summaries):
    // settle the queued sidecar writes, then refresh from disk.
    await store.flush();
    seen.length = 0;
    await store.preload([STREAM]);
    expect(seen.at(-1)?.meta).toMatchObject({ executionId: 'a77e77' });
  });

  it('preserves mirrored metadata when execution hydration is incomplete', async () => {
    vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const executionId = 'a77e77' as ExecutionId;
    await writeMetaFile(STREAM, {
      executionId,
      parentStreamId: OTHER_STREAM,
    });
    vi.spyOn(getExecutionStore(executionId), 'readMeta').mockRejectedValueOnce(
      new Error('transient execution read failure'),
    );
    let mirroredMeta: Record<string, unknown> = {
      executionId,
      parentStreamId: 'previous-parent',
      identity: { kind: 'agent', agent: 'search' },
      description: 'Existing summary metadata',
      model: 'deepseekproT',
    };
    const store = new StreamSnapshotStore();
    store.attachSessionEvents(new SessionEventHub(), {
      summaryMetaSink: (_stream, meta) => {
        mirroredMeta = meta;
      },
      summaryMetaSource: () => mirroredMeta,
    });

    await store.load([STREAM]);

    expect(mirroredMeta).toEqual({
      executionId,
      parentStreamId: OTHER_STREAM,
      identity: { kind: 'agent', agent: 'search' },
      description: 'Existing summary metadata',
      model: 'deepseekproT',
    });
  });

  it('clears old execution metadata when handoff hydration is incomplete', async () => {
    vi.spyOn(logUtils, 'warn').mockImplementation(() => {});
    const executionId = 'b88f88' as ExecutionId;
    await writeMetaFile(STREAM, { executionId });
    vi.spyOn(getExecutionStore(executionId), 'readMeta').mockRejectedValueOnce(
      new Error('transient execution read failure'),
    );
    let mirroredMeta: Record<string, unknown> = {
      executionId: 'a77e77',
      identity: { kind: 'agent', agent: 'search' },
      description: 'Previous execution',
      model: 'deepseekproT',
    };
    const store = new StreamSnapshotStore();
    store.attachSessionEvents(new SessionEventHub(), {
      summaryMetaSink: (_stream, meta) => {
        mirroredMeta = meta;
      },
      summaryMetaSource: () => mirroredMeta,
    });

    await store.load([STREAM]);

    expect(mirroredMeta).toEqual({ executionId });
  });
});
