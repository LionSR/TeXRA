import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { beforeEach, expect, vi } from 'vitest';

import { AgentConfigSchema, type RunId } from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runRecords';
import { registerRun } from '@agent/storage/runLifecycle';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

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
const register = (
  session: Context.Context<SessionServices>,
  workingDirectory?: string,
) =>
  registerRun(
    runId,
    {
      ...baseConfig,
      ...(workingDirectory === undefined ? {} : { workingDirectory }),
    },
    options,
  ).pipe(Effect.provide(session));

beforeEach(() => {
  vi.restoreAllMocks();
});

layer(SessionGraph.layer, { excludeTestServices: true })(
  'run registration and finalization',
  (it) => {
    it.layer(FakeHost.layer({ workspacePath: '/workspace/root' }), {
      buildPerTest: true,
    })((it) => {
      it.effect.each([undefined, '/workspace/paper '])(
        'pins the run working directory for %s',
        (workingDirectory) =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            yield* register(session, workingDirectory);
            expect(
              yield* getRunRecords(runId)
                .readConfig()
                .pipe(Effect.provide(session)),
            ).toMatchObject({
              workingDirectory: workingDirectory ?? '/workspace/root',
            });
          }),
      );

      it.effect(
        'admits a child whose parent is still queued on the publisher',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            // The parent's `run.start` is published and left uncommitted,
            // which is what a record read sees: without the barrier ahead of
            // it, this child is refused as if its parent did not exist.
            const parentRunId = publishTestRunStart(session);
            yield* registerRun(runId, baseConfig, {
              ...options,
              parentRunId,
            }).pipe(Effect.provide(session));
            expect(
              yield* getRunRecords(runId)
                .exists()
                .pipe(Effect.provide(session)),
            ).toBe(true);
            // A parent nothing ever published must still refuse its child
            // rather than wait on the barrier for a row that is not coming.
            const absentParentId = 'def456' as RunId;
            const refusal = yield* Effect.flip(
              registerRun('fed789' as RunId, baseConfig, {
                ...options,
                parentRunId: absentParentId,
              }).pipe(Effect.provide(session)),
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
            const session = yield* isolatedTestSession();
            const failure = new Error('database write failed');
            const log = Context.get(session, SessionLog);
            vi.spyOn(log, 'transact').mockReturnValueOnce(Effect.die(failure));
            expect(yield* Effect.flip(register(session))).toBe(failure);
            expect(yield* log.owns(runId)).toBe(false);
            expect(
              yield* getRunRecords(runId)
                .exists()
                .pipe(Effect.provide(session)),
            ).toBe(false);
          }),
      );
    });
  },
);
