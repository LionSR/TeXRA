/** Stream state is a fold of committed rows, independent of the sidecar format. */
import { it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  aggregateId,
  emptyUsageStats,
  type SessionEventDraft,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { RunSnapshotStore } from '@transcript/StreamSnapshotStore';

const STREAM = 'chat#ab12cd';
const EXECUTION = 'ab12cd';
const start: SessionEventDraft = {
  type: 'run.start',
  aggregateId: aggregateId('stream', STREAM),
  executionId: EXECUTION,
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: 'toolUse',
  isRemote: false,
};
const usage: SessionEventDraft = {
  type: 'usage',
  aggregateId: start.aggregateId,
  storageKey: EXECUTION,
  usage: { ...emptyUsageStats(), inputTokens: 7 },
};
const substrate = databaseLayer('ephemeral').pipe(
  Layer.provide(
    Layer.succeed(WorkspaceRoots)({ storage: '/stream-state-test' }),
  ),
  Layer.provide(ProcessIdentity.layer('["test-host",4242,"self-start"]')),
);

describe('StreamSnapshotStore event fold', () => {
  it.effect(
    'rebuilds work plans and round artifacts with the live fold rules',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        const store = new RunSnapshotStore(database);
        const location = {
          kind: 'workspace' as const,
          absolutePath: '/paper/main.tex',
          relativePath: 'main.tex',
        };
        const output = {
          source: 'main.tex',
          location,
          round: 1,
          lineage: null,
          diff: null,
        };
        const failure = {
          round: 1,
          displayName: 'main.tex',
          output: location,
          log: location,
          logRelativePath: 'main.log',
        };
        const plan = {
          objective: 'Prove conservation.\nCheck the boundary terms.',
        };
        const todos = [
          {
            content: 'Check boundary terms',
            activeForm: 'Checking boundary terms',
            status: 'pending' as const,
          },
        ];
        yield* database.appendAll([
          start,
          { type: 'updatePlan', aggregateId: start.aggregateId, plan },
          { type: 'updateTodos', aggregateId: start.aggregateId, todos },
          {
            type: 'addOutputFiles',
            aggregateId: start.aggregateId,
            filesByRound: { 1: [output] },
          },
          {
            type: 'updateMissingOutputs',
            aggregateId: start.aggregateId,
            filesByRound: { 1: ['appendix.tex'] },
          },
          {
            type: 'updateCompileFailures',
            aggregateId: start.aggregateId,
            filesByRound: { 1: [failure] },
          },
        ]);
        yield* store.preload([STREAM]);
        expect(store.getWorkPlan(STREAM)).toEqual({
          plan,
          todos,
          planSummary: 'Prove conservation.',
        });
        expect(
          store.getKnownFilePaths(STREAM, { workspaceOnly: true }),
        ).toEqual(new Set(['/paper/main.tex']));
        expect(store.getCompileFailures(STREAM)).toEqual({ 1: [failure] });
        const apply = store.attachSessionEvents();
        for (const event of yield* database.appendAll([
          {
            type: 'addOutputFiles',
            aggregateId: start.aggregateId,
            filesByRound: { 1: [] },
          },
          {
            type: 'updateMissingOutputs',
            aggregateId: start.aggregateId,
            filesByRound: { 1: [] },
          },
          {
            type: 'updateCompileFailures',
            aggregateId: start.aggregateId,
            filesByRound: { 1: [] },
          },
        ]))
          yield* apply(event);
        expect(store.getOutputFiles(STREAM)).toEqual({});
        expect(store.getMissingOutputs(STREAM)).toEqual({ 1: [] });
        expect(store.getCompileFailures(STREAM)).toEqual({});
        const cold = yield* store.read(STREAM);
        expect(cold.outputFilesByRound).toEqual(store.getOutputFiles(STREAM));
        expect(cold.missingOutputsByRound).toEqual(
          store.getMissingOutputs(STREAM),
        );
        expect(cold.compileFailuresByRound).toEqual(
          store.getCompileFailures(STREAM),
        );
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'hydrates a complete prefix and ignores its repeated live delivery',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        const store = new RunSnapshotStore(database);
        const events = yield* database.appendAll([
          start,
          usage,
          {
            type: 'updateStreamDescription',
            aggregateId: start.aggregateId,
            description: 'A conserved quantity',
          },
        ]);
        const cold = yield* store.read(STREAM);
        expect(cold.runUsage[EXECUTION]?.inputTokens).toBe(7);
        expect(store.hasProvenance(STREAM)).toBe(false);
        yield* store.preload([STREAM]);
        const apply = store.attachSessionEvents();
        for (const event of events) yield* apply(event);
        expect(store.getRunUsage(STREAM).get(EXECUTION)?.inputTokens).toBe(7);
        expect(store.getRunMetadata(STREAM)).toMatchObject({
          executionId: EXECUTION,
          description: 'A conserved quantity',
        });
        yield* store.requestEviction(STREAM);
        expect(store.hasProvenance(STREAM)).toBe(false);
        expect((yield* store.read(STREAM)).runUsage).toEqual(cold.runUsage);
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'serializes a cold prefix with a later committed fact without overwriting it',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll([start]);
        const reading = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const store = new RunSnapshotStore({
          readListing: database.readListing,
          readAggregate: (id, seq) =>
            Effect.gen(function* () {
              const rows = yield* database.readAggregate(id, seq);
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(release);
              return rows;
            }),
        });
        const reader = yield* store.preload([STREAM]).pipe(Effect.forkChild);
        yield* Deferred.await(reading);
        const committed = yield* database.appendAll([usage]);
        const apply = store.attachSessionEvents();
        const tail = yield* Effect.forEach(committed, apply).pipe(
          Effect.forkChild,
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(reader);
        yield* Fiber.join(tail);
        expect(store.getRunUsage(STREAM).get(EXECUTION)?.inputTokens).toBe(7);
      }).pipe(Effect.provide(substrate)),
  );

  it.effect(
    'keeps unhydrated history cold and makes a tombstone remove its folded state',
    () =>
      Effect.gen(function* () {
        const database = yield* Database;
        yield* database.appendAll([start]);
        const store = new RunSnapshotStore(database);
        const apply = store.attachSessionEvents();
        for (const event of yield* database.appendAll([usage]))
          yield* apply(event);
        expect(store.hasProvenance(STREAM)).toBe(false);
        yield* store.preload([STREAM]);
        expect(store.getExecutionIdMap().get(STREAM)).toBe(EXECUTION);
        expect(yield* store.listPersistedStreams()).toEqual([STREAM]);
        for (const event of yield* database.appendAll([
          { type: 'stream.removed', aggregateId: start.aggregateId },
        ]))
          yield* apply(event);
        expect(store.hasProvenance(STREAM)).toBe(false);
        expect(store.getExecutionIdMap().has(STREAM)).toBe(false);
        expect((yield* store.read(STREAM)).runUsage).toEqual({});
        expect(yield* store.listPersistedStreams()).toEqual([]);
      }).pipe(Effect.provide(substrate)),
  );
});
