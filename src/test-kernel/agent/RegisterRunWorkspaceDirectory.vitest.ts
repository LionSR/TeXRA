import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { getRunRecords } from '@agent/storage/runRecords';
import { registerRun } from '@agent/storage/runLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { AgentConfigSchema, type RunId } from '@shared/schemas';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace/root' });
const baseConfig = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'chat',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Check the proof.',
});
const runId = 'abc123' as RunId;
const options = {
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'nativeInteractive',
} as const;
let session: SessionHandle;
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

beforeEach(async () => {
  vi.restoreAllMocks();
  session = await Effect.runPromise(createTestSession());
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
        vi.spyOn(session.log, 'transact').mockReturnValueOnce(
          Effect.die(failure),
        );
        expect(yield* Effect.flip(register())).toBe(failure);
        expect(yield* session.log.owns(runId)).toBe(false);
        expect(yield* getRunRecords(session, runId).exists()).toBe(false);
      }),
  );
});
