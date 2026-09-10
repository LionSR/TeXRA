import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { z } from 'zod';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  clearStoreCache,
  deriveResumability,
  finalizeRun,
  getExecutionStore,
} from '@agent/storage';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  FLOW_RECORD_SCHEMA_VERSION,
  flowKey,
  type FlowRecord,
} from '@agent/node/persistedFlow';
import {
  aggregateId,
  type StreamTabId,
  RUN_OUTCOME,
  type ExecutionId,
  type RunOutcome,
} from '@shared/schemas';
import {
  createProcessSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

const BASE_FLOW_RECORD: FlowRecord = {
  shared: { messages: [] },
  cursor: { nextNodeId: 'start' },
};

describe('deriveResumability', () => {
  setupPlatform({ workspacePath: '/workspace' });

  let session: SessionHandle;
  beforeEach(() => {
    clearStoreCache();
    vi.restoreAllMocks();
    session = createProcessSession();
  });

  function writeFlow(executionId: ExecutionId) {
    return Effect.promise(() =>
      getExecutionStore(executionId).write(
        flowKey(executionId),
        BASE_FLOW_RECORD,
      ),
    );
  }

  function writeMeta(
    executionId: ExecutionId,
    { outcome }: { outcome?: RunOutcome },
  ) {
    return Effect.gen(function* () {
      const streamId = `stream-${executionId}` as StreamTabId;
      publishTestRunStart(session, streamId, executionId);
      yield* Effect.promise(() => session.settlePublications());
      if (outcome) {
        yield* session.commit([
          {
            type: 'status',
            aggregateId: aggregateId('stream', streamId),
            phase: outcome,
            cause: 'test outcome',
          },
        ]);
      }
    });
  }

  it.effect(
    'keeps a failed execution resumable while its checkpoint exists',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0000' as ExecutionId;
        yield* writeMeta(executionId, { outcome: RUN_OUTCOME.FAILED });
        yield* writeFlow(executionId);

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'checkpoint',
          outcome: RUN_OUTCOME.FAILED,
          flowRecord: BASE_FLOW_RECORD,
        });
      }),
  );

  it.effect(
    'stays resumable when terminal metadata persists but flow deletion fails',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0001' as ExecutionId;
        yield* writeMeta(executionId, {});
        yield* writeFlow(executionId);
        const store = getExecutionStore(executionId);
        vi.spyOn(store, 'delete').mockRejectedValueOnce(
          new Error('flow delete failed'),
        );

        expect(
          yield* finalizeRun(session, {
            executionId,
            outcome: RUN_OUTCOME.COMPLETED,
            flowRecord: 'delete',
          }),
        ).toMatchObject({
          ok: false,
          outcomePersisted: true,
        });

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'checkpoint',
          outcome: RUN_OUTCOME.COMPLETED,
        });
      }),
  );

  it.effect('does not treat a spent cursor as a checkpoint', () =>
    Effect.gen(function* () {
      const executionId = 'ac0002' as ExecutionId;
      yield* writeMeta(executionId, { outcome: RUN_OUTCOME.COMPLETED });
      yield* Effect.promise(() =>
        getExecutionStore(executionId).write(flowKey(executionId), {
          ...BASE_FLOW_RECORD,
          cursor: { ...BASE_FLOW_RECORD.cursor, nextNodeId: null },
        }),
      );

      expect(yield* deriveResumability(executionId, session)).toMatchObject({
        kind: 'unreadable',
        cause: 'checkpoint is malformed',
      });
    }),
  );

  it.effect(
    'keeps a preserved checkpoint when terminal metadata fails for a failed execution',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0003' as ExecutionId;
        yield* writeMeta(executionId, {});
        yield* writeFlow(executionId);
        vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
          Effect.die(new Error('metadata disk full')),
        );

        expect(
          yield* finalizeRun(session, {
            executionId,
            outcome: RUN_OUTCOME.FAILED,
            flowRecord: 'preserve',
          }),
        ).toMatchObject({
          ok: false,
          outcomePersisted: false,
        });

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'checkpoint',
        });
      }),
  );

  it.effect(
    'marks cancelled executions with a valid flow record as resumable',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0004' as ExecutionId;
        yield* writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });
        yield* writeFlow(executionId);

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'checkpoint',
          outcome: RUN_OUTCOME.CANCELLED,
          flowRecord: BASE_FLOW_RECORD,
        });
      }),
  );

  it.effect(
    'does not mark cancelled executions resumable without a flow record',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0005' as ExecutionId;
        yield* writeMeta(executionId, { outcome: RUN_OUTCOME.CANCELLED });

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'none',
          outcome: RUN_OUTCOME.CANCELLED,
        });
      }),
  );

  it.effect(
    'marks missing-terminal executions with a valid flow record as resumable',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0006' as ExecutionId;
        yield* writeFlow(executionId);

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'checkpoint',
          flowRecord: BASE_FLOW_RECORD,
        });
      }),
  );

  it.effect(
    'accepts an unstamped legacy envelope and preserves extra fields',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac0007' as ExecutionId;
        const legacyRecord = {
          ...BASE_FLOW_RECORD,
          legacyOwner: { host: 'extension' },
        };
        yield* Effect.promise(() =>
          getExecutionStore(executionId).write(
            flowKey(executionId),
            legacyRecord,
          ),
        );

        const decision = yield* deriveResumability(executionId, session);

        expect(decision).toMatchObject({ kind: 'checkpoint' });
        if (decision.kind !== 'checkpoint') return;
        expect(decision.flowRecord).toEqual(legacyRecord);
        expect(Object.hasOwn(decision.flowRecord, 'schemaVersion')).toBe(false);
      }),
  );

  it.effect('reports missing flow records as not resumable', () =>
    Effect.gen(function* () {
      const executionId = 'ac0008' as ExecutionId;

      expect(yield* deriveResumability(executionId, session)).toEqual({
        kind: 'none',
        outcome: undefined,
      });
    }),
  );

  it.effect.each([
    {
      name: 'reports invalid flow records as not resumable',
      record: { ...BASE_FLOW_RECORD, shared: null },
    },
    {
      name: 'does not conflate a stored null flow envelope with an absent key',
      record: null,
    },
    {
      name: 'rejects flow records from a future envelope schema version',
      record: {
        ...BASE_FLOW_RECORD,
        schemaVersion: FLOW_RECORD_SCHEMA_VERSION + 1,
      },
    },
  ])('$name', ({ record }) =>
    Effect.gen(function* () {
      const executionId = 'ac0009' as ExecutionId;
      yield* Effect.promise(() =>
        getExecutionStore(executionId).write(flowKey(executionId), record),
      );

      expect(yield* deriveResumability(executionId, session)).toEqual({
        kind: 'unreadable',
        // The one fault that names the record itself: callers refuse this
        // cohort as unusable saved state, and every other fault operationally.
        fault: 'checkpoint-malformed',
        cause: 'checkpoint is malformed',
      });
    }),
  );

  it.effect(
    'reports invalid metadata as not resumable even with a valid flow record',
    () =>
      Effect.gen(function* () {
        const executionId = 'ac000a' as ExecutionId;
        vi.spyOn(session, 'readExecutionRecords').mockReturnValue(
          Effect.die(
            new z.ZodError([
              {
                code: 'custom',
                path: [],
                message: 'corrupt execution metadata',
              },
            ]),
          ),
        );
        yield* writeFlow(executionId);

        expect(yield* deriveResumability(executionId, session)).toMatchObject({
          kind: 'unreadable',
          cause: 'execution metadata is malformed',
        });
      }),
  );

  it.effect('reports unreadable flow records as not resumable', () =>
    Effect.gen(function* () {
      const executionId = 'ac000b' as ExecutionId;
      const store = getExecutionStore(executionId);
      yield* writeFlow(executionId);
      const originalRead = store.read.bind(store);
      vi.spyOn(store, 'read').mockImplementation(async (key) => {
        if (key === flowKey(executionId)) {
          throw new Error('disk offline');
        }
        return originalRead(key);
      });

      expect(yield* deriveResumability(executionId, session)).toMatchObject({
        kind: 'unreadable',
        cause: 'checkpoint could not be read (disk offline)',
      });
    }),
  );
});
