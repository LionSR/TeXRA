import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { expect } from 'vitest';
import {
  AgentConfigSchema,
  runBypasses,
  type RunId,
} from '@texra-ai/harness/schemas';
import { goalGrant, humanGrant } from '@agent/runtime/runApprovalQueue';

import { activationRows, registerRun } from '@agent/storage/runLifecycle';
import {
  SessionLog,
  RunHistory,
  SessionViewAccess,
  Approvals,
} from '@shared/session/runHistory';
import { BUNDLED_AGENTS } from '@test/support/storeFaults';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const EXECUTION_ID = 'a00101' as RunId;

const tempDirs = useTempDirs();

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'AgentLaunchContext',
  (it) => {
    // The built-in agents are the bundled personas: a launch resolves its
    // agent, or misses, against the catalog a real host scans.
    it.layer(
      FakeHost.layer(async () => {
        const host = await createTempDirPlatform('texra-launch-', tempDirs);
        return {
          ...host,
          platform: {
            ...host.platform,
            agentDirectories: {
              ...host.platform.agentDirectories,
              builtIn: () => Effect.succeed(BUNDLED_AGENTS),
            },
          },
        };
      }),
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
              agent: 'chat',
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
            yield* Context.get(session, SessionLog).settled;

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
            expect(view.policy.get(EXECUTION_ID)).toEqual({
              own: { toolEdit: 'on' },
              goal: [],
            });
          }),
      );
    });
  },
);
