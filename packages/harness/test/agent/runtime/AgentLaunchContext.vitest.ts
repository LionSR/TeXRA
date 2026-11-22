import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { expect } from 'vitest';
import {
  RunIdSchema,
  AgentConfigSchema,
  runBypasses,
} from '@texra-ai/worldline/schemas';
import { goalGrant, humanGrant } from '@agent/runtime/runApprovalQueue';

import { activationRows, registerRun } from '@agent/storage/runLifecycle';
import {
  SessionLog,
  RunHistory,
  SessionViewAccess,
  Approvals,
} from '@shared/session/runHistory';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const EXECUTION_ID = Schema.decodeUnknownSync(RunIdSchema)('a00101');

const tempDirs = useTempDirs();

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'AgentLaunchContext',
  (it) => {
    it.layer(
      FakeHost.layer(() => createTempDirPlatform('texra-launch-', tempDirs)),
      { buildPerTest: true },
    )((it) => {
      it.effect(
        "restores a resumed run's human grants from its durable policy, not its goal's",
        () =>
          Effect.gen(function* () {
            // Failure modes: a resume in a new process forgets an
            // approve-for-session grant; its re-stamp overwrites the durable
            // grant with an empty snapshot; a goal's auto-approval comes back
            // on without a human re-arming it.
            const session = yield* isolatedTestSession();
            const config = Schema.decodeUnknownSync(AgentConfigSchema)({
              label: 'chat',
              model: 'openai/gpt-5.5-2026-04-23',
            });
            yield* registerRun(EXECUTION_ID, config, {
              identity: { kind: 'agent', agent: 'chat' },
            }).pipe(Effect.provide(session));
            // A human approves edits for the session; the run's goal then
            // auto-approves its commands.
            yield* Context.get(session, Approvals).change(
              EXECUTION_ID,
              humanGrant(['toolEdit'], true),
            );
            yield* Context.get(session, Approvals).change(
              EXECUTION_ID,
              goalGrant(['bash']),
            );
            yield* Context.get(session, SessionLog).drained;

            // A resume's activation, as its run's cell commits it.
            yield* Context.get(session, RunHistory).open(EXECUTION_ID, {
              activation: () =>
                activationRows(EXECUTION_ID, config).pipe(
                  Effect.provide(session),
                ),
            });

            // The human's grant stands; the goal's ends with the activation.
            const view = yield* Context.get(session, SessionViewAccess).read(
              [],
            );
            expect(runBypasses(view, EXECUTION_ID)).toEqual({
              bash: false,
              toolEdit: true,
              superYolo: false,
            });
            expect(view.runs.get(EXECUTION_ID)?.grants).toEqual({
              own: { toolEdit: 'on' },
              goal: [],
            });
          }),
      );
    });
  },
);
