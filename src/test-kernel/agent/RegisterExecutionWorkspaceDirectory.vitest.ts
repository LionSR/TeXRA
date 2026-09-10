import { it } from '@effect/vitest';
import { Cause, Effect, Exit } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { getRunRecords, getRunStore } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { runInSession } from '@agent/runtime/RunContext';
import { flowKey } from '@agent/node/persistedFlow';
import {
  finalizeRun,
  acquireResumedRunOwnership,
  registerRun,
} from '@agent/storage/executionLifecycle';
import { inspectRunLease } from '@agent/storage/executionLease';
import { createTestSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace/root' });
const baseConfig = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
});
const executionId = 'abc123';
const options = {
  streamId: 'stream:abc123',
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'nativeInteractive',
} as const;
let session: ReturnType<typeof createTestSession>;
/** The failure an exit carries, or undefined when it succeeded. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
const register = (workingDirectory?: string) =>
  registerRun(
    session,
    executionId,
    {
      ...baseConfig,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    },
    'chat',
    options,
  );
/** Lease and store reads run through the session's run context, not Effect. */
const inSession = <T>(fn: () => Promise<T>): Effect.Effect<T> =>
  Effect.promise(() => runInSession(session, fn));

beforeEach(() => {
  vi.restoreAllMocks();
  session = createTestSession();
});

describe('execution registration and finalization', () => {
  it.effect.each([undefined, '/workspace/paper '])(
    'pins the execution working directory for %s',
    (workingDirectory) =>
      Effect.gen(function* () {
        yield* register(workingDirectory);
        expect(
          yield* getRunRecords(session, executionId).readConfig(),
        ).toMatchObject({
          workingDirectory: workingDirectory ?? '/workspace/root',
        });
        expect(
          yield* getRunRecords(session, executionId).readMeta(),
        ).toMatchObject({
          streamId: options.streamId,
          identity: options.identity,
          userFollowUpSupport: 'nativeInteractive',
        });
        expect(
          yield* Effect.promise(() => getRunStore(executionId).listKeys()),
        ).toEqual([]);
      }),
  );

  it.effect(
    'rolls back file ownership when the registration transaction fails',
    () =>
      Effect.gen(function* () {
        const failure = new Error('database write failed');
        vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
          Effect.die(failure),
        );
        expect(failureOf(yield* Effect.exit(register()))).toBe(failure);
        expect(yield* inSession(() => inspectRunLease(executionId))).toEqual({
          status: 'free',
        });
        expect(
          yield* getRunRecords(session, executionId).readMeta(),
        ).toBeNull();
      }),
  );

  it.effect.each([false, true])(
    'preserves preexisting file ownership %s when database admission fails',
    (alreadyOwned) =>
      Effect.gen(function* () {
        yield* register();
        if (!alreadyOwned) yield* session.releaseExecutionLease(executionId);
        const failure = new Error('database admission rejected');
        vi.spyOn(session, 'acquireExecutionClaims').mockReturnValueOnce(
          Effect.fail(failure),
        );
        expect(
          failureOf(
            yield* Effect.exit(
              acquireResumedRunOwnership(
                session,
                executionId,
                options.streamId,
              ),
            ),
          ),
        ).toBe(failure);
        const lease = yield* inSession(() => inspectRunLease(executionId));
        expect(lease.status).toBe(alreadyOwned ? 'owned' : 'free');
      }),
  );

  it.effect(
    'releases reacquired database claims when repeated registration fails',
    () =>
      Effect.gen(function* () {
        yield* register();
        yield* session.releaseExecutionLease(executionId);
        const failure = new Error('registration rejected');
        vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
          Effect.die(failure),
        );
        expect(failureOf(yield* Effect.exit(register()))).toBe(failure);
        expect(
          failureOf(
            yield* Effect.exit(
              getRunRecords(session, executionId).writeReport('unowned'),
            ),
          ),
        ).toBeInstanceOf(Error);
        yield* session.acquireExecutionClaims(executionId, options.streamId);
        yield* getRunRecords(session, executionId).writeReport('owned');
        expect(yield* getRunRecords(session, executionId).readReport()).toBe(
          'owned',
        );
      }),
  );

  it.effect(
    'keeps the existing local run claimed when a new birth collides with its stream',
    () =>
      Effect.gen(function* () {
        yield* register();
        expect(
          failureOf(
            yield* Effect.exit(
              registerRun(session, 'bcd234', baseConfig, 'chat', options),
            ),
          ),
        ).toBeInstanceOf(Error);
        yield* getRunRecords(session, executionId).writeReport('still owned');
        expect(yield* getRunRecords(session, executionId).readReport()).toBe(
          'still owned',
        );
      }),
  );

  it.effect(
    'releases fresh birth claims when the committed publication consumer fails',
    () =>
      Effect.gen(function* () {
        vi.spyOn(session, 'receiveCommittedEvent').mockReturnValue(
          Effect.die(new Error('consumer failed')),
        );
        expect(failureOf(yield* Effect.exit(register()))).toBeInstanceOf(Error);
        expect(
          yield* getRunRecords(session, executionId).readMeta(),
        ).not.toBeNull();
        expect(
          failureOf(
            yield* Effect.exit(
              getRunRecords(session, executionId).writeReport('unowned'),
            ),
          ),
        ).toBeInstanceOf(Error);
        expect(yield* inSession(() => inspectRunLease(executionId))).toEqual({
          status: 'free',
        });
      }),
  );

  it.effect.each(['preserve', 'delete'] as const)(
    'retains the existing requested checkpoint disposition %s',
    (flowRecord) =>
      Effect.gen(function* () {
        yield* register();
        const store = getRunStore(executionId);
        yield* inSession(() =>
          store.write(flowKey(executionId), { checkpoint: 'existing format' }),
        );
        expect(
          yield* finalizeRun(session, {
            executionId,
            outcome: 'completed',
            flowRecord,
          }),
        ).toEqual({ ok: true, outcome: 'completed' });
        expect(yield* inSession(() => store.exists(flowKey(executionId)))).toBe(
          flowRecord === 'preserve',
        );
      }),
  );

  it.effect.each([
    { statusFails: true, deletionFails: false },
    { statusFails: true, deletionFails: true },
    { statusFails: false, deletionFails: true },
  ])(
    'preserves independent finalization failures $statusFails/$deletionFails',
    ({ statusFails, deletionFails }) =>
      Effect.gen(function* () {
        yield* register();
        const statusFailure = new Error('status write failed');
        const deletionFailure = new Error('checkpoint delete failed');
        if (statusFails)
          vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
            Effect.die(statusFailure),
          );
        const deletion = vi.spyOn(getRunStore(executionId), 'delete');
        if (deletionFails) deletion.mockRejectedValueOnce(deletionFailure);
        const result = yield* finalizeRun(session, {
          executionId,
          outcome: 'failed',
          flowRecord: 'delete',
        });
        expect(result).toMatchObject({
          ok: false,
          outcomePersisted: !statusFails,
        });
        expect(deletion).toHaveBeenCalledWith(flowKey(executionId));
        const singleFailure = statusFails ? statusFailure : deletionFailure;
        if (!result.ok)
          expect(result.error).toEqual(
            statusFails && deletionFails
              ? new AggregateError(
                  [statusFailure, deletionFailure],
                  `Terminal status and flow deletion failed for ${executionId}`,
                )
              : singleFailure,
          );
      }),
  );
});
