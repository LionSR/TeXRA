import { layer } from '@effect/vitest';
/** Completed conversation reads and task reads through the archive facade. */
import { Effect, Schema, Context } from 'effect';
import { afterEach, beforeEach, expect, vi } from 'vitest';

import { API_KEY_ENV_NAMES } from '@texra-ai/llm';

import {
  type AgentConfig,
  AgentConfigSchema,
  MESSAGE_TYPES,
  qualifyAggregateId,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import { resumeRun } from '@agent/runtime/resumeRun';
import { SessionRoots } from '@platform/rootedFs';
import { SessionLog } from '@shared/session/runHistory';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { BUNDLED_AGENTS } from '@test/support/storeFaults';
import {
  publishTestRunStart,
  publishTestRows,
  seedRows,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import {
  FakeHost,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { TEXRA_APP, texraHosted } from '@test/support/texraApp';
import { ExecutionsTool } from '@tools/ExecutionsTool';
import { readCompletedRunConversation as readCompletedRunConversationEffect } from '@transcript/completedRunArchive';

const tempDirs = useTempDirs();

function runConfig(
  agent: string,
  model = 'deepseek/deepseek-v4-pro',
): AgentConfig {
  return Schema.decodeUnknownSync(AgentConfigSchema)({
    agent,
    model,
  });
}

// Live clock: the session's publisher and the resume run on real turns.
layer(texraHosted, { excludeTestServices: true })(
  'completedRunArchive facade',
  (it) => {
    // The built-in agents are the bundled personas, so a resume resolves the
    // run's `orchestrator` the way a real host does.
    it.layer(
      FakeHost.layer(async () => {
        const host = await createTempDirPlatform(
          'texra-archive-',
          tempDirs,
          TEXRA_APP,
        );
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
      beforeEach(() => {
        // The session runtime reads key variables from the process environment;
        // a blank one counts as unset, so the resume below finds no key whatever
        // the developer's or CI's shell holds.
        for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
      });

      afterEach(() => {
        vi.unstubAllEnvs();
      });

      it.effect(
        'reconstructs both turns after a production resume that failed before it entered the run',
        () =>
          Effect.gen(function* () {
            const runId = Schema.decodeSync(RunIdSchema)('0aa1110aa111');
            const config = runConfig('orchestrator');

            // The session over the host's roots, on its persistent store.
            const session = yield* sessionHandleOf(
              yield* TestSession.open(testWorkspaceRoots(), {
                persistent: true,
                host: {},
              }),
            );
            publishTestRunStart(session, runId);
            yield* Context.get(session, SessionLog).settled;
            yield* seedRunRecord(session, runId, config);
            publishTestRows(session, [
              {
                type: 'log',
                aggregateId: qualifyAggregateId('run', runId),
                level: 'info',
                messageType: MESSAGE_TYPES.USER_MESSAGE,
                message: 'Prove the first lemma.',
              },
              {
                type: 'response.finalized',
                aggregateId: qualifyAggregateId('run', runId),
                text: 'First proof.',
              },
            ]);
            yield* Context.get(session, SessionLog).settled;

            // The one fact a resume reads: the run's opening `run.position`.
            yield* seedRows(Context.get(session, SessionLog))([
              {
                type: 'run.position',
                aggregateId: qualifyAggregateId('run', runId),
                payload: { family: 'toolUse', at: 'turn.ready', turn: 0 },
              },
            ]);

            // The second turn, as a run that continued would have left it.
            publishTestRows(session, [
              {
                type: 'log',
                aggregateId: qualifyAggregateId('run', runId),
                level: 'info',
                messageType: MESSAGE_TYPES.USER_MESSAGE,
                message: 'Now prove the second lemma.',
              },
              {
                type: 'response.finalized',
                aggregateId: qualifyAggregateId('run', runId),
                text: 'Second proof.',
              },
            ]);
            yield* Context.get(session, SessionLog).settled;

            // The resumed launch stops before it enters the run (no provider key
            // binds its model): it writes nothing and lets the claim go.
            expect(
              (yield* Effect.flip(
                resumeRun(runId, {}).pipe(Effect.provide(session)),
              )).message,
            ).toContain('Missing API key');

            expect(
              (yield* Effect.exit(
                Context.get(session, SessionLog).transact([
                  {
                    type: 'log',
                    aggregateId: qualifyAggregateId('run', runId),
                    level: 'info',
                    message: 'late stream write',
                  },
                ]),
              ))._tag,
            ).toBe('Failure');
            expect(yield* Context.get(session, SessionLog).owns(runId)).toBe(
              false,
            );

            const archived = yield* readCompletedRunConversationEffect(
              runId,
              Context.get(session, SessionRoots).config,
            ).pipe(Effect.provide(session));
            expect(archived).toEqual([
              {
                kind: 'user-message',
                parts: [{ type: 'text', text: 'Prove the first lemma.' }],
              },
              { kind: 'assistant-text', text: 'First proof.' },
              {
                kind: 'user-message',
                parts: [{ type: 'text', text: 'Now prove the second lemma.' }],
              },
              { kind: 'assistant-text', text: 'Second proof.' },
            ]);

            const toolLayer = nativeToolTestLayer({
              run: { session, runId, toolPolicy: {} },
              roots: Context.get(session, SessionRoots),
            });

            const firstPage = yield* ExecutionsTool.call({
              path: `/executions/${runId}/conversation`,
              offset: 0,
              limit: 2,
            }).pipe(Effect.provide(toolLayer));
            const secondPage = yield* ExecutionsTool.call({
              path: `/executions/${runId}/conversation`,
              offset: 2,
              limit: 2,
            }).pipe(Effect.provide(toolLayer));
            expect(firstPage.output).toContain(
              'Returned message interval: [0, 2)',
            );
            expect(firstPage.output).toContain('Next offset: 2');
            expect(firstPage.output).not.toContain(
              'Now prove the second lemma.',
            );
            expect(secondPage.output).toContain(
              'Returned message interval: [2, 4)',
            );
            expect(secondPage.output).toContain('Next offset: none');
            expect(secondPage.output).not.toContain('Prove the first lemma.');
          }),
      );
    });
  },
);
