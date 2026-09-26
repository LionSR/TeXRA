import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { getRunRecords } from '@agent/storage';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { finalizeRun, registerRun } from '@agent/storage/runLifecycle';
import { aggregateId, type RunId } from '@shared/schemas';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace/root' });
const baseConfig = AgentConfigSchema.parse({
  agent: 'chat',
  model: 'deepseekT',
  instruction: 'Check the proof.',
  agentCategory: 'toolUse',
});
const runId = 'abc123' as RunId;
const options = {
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'nativeInteractive',
} as const;
let session: ReturnType<typeof createTestSession>;
const register = (workingDirectory?: string) =>
  registerRun(
    session,
    runId,
    {
      ...baseConfig,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    },
    options,
  );

beforeEach(() => {
  vi.restoreAllMocks();
  session = createTestSession();
});

describe('run registration and finalization', () => {
  it.effect.each([undefined, '/workspace/paper '])(
    'pins the run working directory for %s',
    (workingDirectory) =>
      Effect.gen(function* () {
        yield* register(workingDirectory);
        expect(yield* getRunRecords(session, runId).readConfig()).toMatchObject(
          {
            workingDirectory: workingDirectory ?? '/workspace/root',
          },
        );
        expect(
          (yield* session.readView([runId])).runs.get(runId),
        ).toMatchObject({
          identity: options.identity,
          followUpSupport: 'nativeInteractive',
        });
      }),
  );

  it.effect(
    'admits a child whose parent is still queued on the publisher',
    () =>
      Effect.gen(function* () {
        // The parent's `run.start` is published and left uncommitted, which is
        // what a record read sees: without the barrier ahead of it, this child is
        // refused as if its parent did not exist.
        const parentRunId = publishTestRunStart(session);
        yield* registerRun(session, runId, baseConfig, {
          ...options,
          parentRunId,
        });
        expect(yield* getRunRecords(session, runId).exists()).toBe(true);
        // A parent nothing ever published must still refuse its child rather
        // than wait on the barrier for a row that is not coming.
        const absentParentId = 'def456' as RunId;
        const refusal = yield* Effect.flip(
          registerRun(session, 'fed789' as RunId, baseConfig, {
            ...options,
            parentRunId: absentParentId,
          }),
        );
        expect(refusal.message).toBe(
          `Parent run ${absentParentId} is unavailable.`,
        );
      }),
  );

  it.effect(
    "rolls back the run's claim when the registration transaction fails",
    () =>
      Effect.gen(function* () {
        const failure = new Error('database write failed');
        vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
          Effect.die(failure),
        );
        expect(yield* Effect.flip(register())).toBe(failure);
        expect(yield* session.ownsRun(runId)).toBe(false);
        expect(yield* getRunRecords(session, runId).exists()).toBe(false);
      }),
  );

  it.effect.each([false, true])(
    'preserves preexisting ownership %s when database admission fails',
    (alreadyOwned) =>
      Effect.gen(function* () {
        yield* register();
        // Registration left the birth claim standing; a run nobody drives
        // any more has given it back.
        if (!alreadyOwned) yield* Effect.scoped(session.holdRunClaim(runId));
        const failure = new DatabaseReadFailed({
          path: 'session.db',
          cause: new Error('database admission rejected'),
        });
        vi.spyOn(session, 'acquireClaims').mockReturnValueOnce(
          Effect.fail(failure),
        );
        expect(
          yield* Effect.flip(Effect.scoped(session.holdRunClaim(runId))),
        ).toBe(failure);
        expect(yield* session.ownsRun(runId)).toBe(alreadyOwned);
      }),
  );

  it.effect(
    'releases reacquired database claims when repeated registration fails',
    () =>
      Effect.gen(function* () {
        yield* register();
        yield* Effect.scoped(session.holdRunClaim(runId));
        const failure = new Error('registration rejected');
        vi.spyOn(session, 'commitRegistration').mockReturnValueOnce(
          Effect.die(failure),
        );
        expect(yield* Effect.flip(register())).toBe(failure);
        const refused = yield* Effect.flip(
          getRunRecords(session, runId).writeReport('unowned'),
        );
        expect(refused).toBeInstanceOf(Error);
        yield* session.acquireClaims(aggregateId('run', runId));
        yield* getRunRecords(session, runId).writeReport('owned');
        expect(yield* getRunRecords(session, runId).readReport()).toBe('owned');
      }),
  );

  it.effect(
    'reports a terminal status write that failed, and persists nothing',
    () =>
      Effect.gen(function* () {
        yield* register();
        const failure = new Error('status write failed');
        vi.spyOn(session, 'updateRecordFacts').mockReturnValueOnce(
          Effect.die(failure),
        );
        // The run's rows live until explicit deletion (C9): finalization writes
        // the terminal row and removes nothing beside it, so a failed write is
        // the whole failure and comes back unwrapped.
        const result = yield* finalizeRun(session, {
          runId,
          outcome: 'failed',
        });
        expect(result).toMatchObject({ ok: false, outcomePersisted: false });
        if (!result.ok) expect(result.error).toBe(failure);
      }),
  );
});
