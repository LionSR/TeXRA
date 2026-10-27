import { it } from '@effect/vitest';
/** Completed conversation reads and task reads through the archive facade. */
import { Effect, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { API_KEY_ENV_NAMES } from '@texra-ai/llm';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { resumeRun } from '@agent/runtime/resumeRun';
import { withProcessServices } from '@platform/processRuntime';
import {
  AgentConfigSchema,
  MESSAGE_TYPES,
  qualifyAggregateId,
} from '@shared/schemas';
import type { RunId } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { BUNDLED_AGENTS } from '@test/support/storeFaults';
import {
  createProcessSession,
  publishTestRunStart,
  publishTestRows,
  seedRows,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import {
  closeTestSession as closeSessionAt,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
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

let taskSession: SessionHandle;

function closeTestSession(session: SessionHandle): Effect.Effect<void, Error> {
  return closeSessionAt(session.roots.storage).pipe(
    Effect.flatMap((report) =>
      report.settled && report.abandoned.length === 0
        ? Effect.void
        : Effect.fail(
            new Error(
              `Test session did not close: ${report.abandoned.join(', ')}`,
            ),
          ),
    ),
  );
}

describe('completedRunArchive facade', () => {
  // The built-in agents are the bundled personas, so a resume resolves the
  // run's `orchestrator` the way a real host does.
  setupPlatform(async () => {
    const host = await createTempDirPlatform('texra-archive-', tempDirs);
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
  });

  beforeEach(async () => {
    // The session runtime reads key variables from the process environment;
    // a blank one counts as unset, so the resume below finds no key whatever
    // the developer's or CI's shell holds.
    for (const name of API_KEY_ENV_NAMES) vi.stubEnv(name, '');
    taskSession = await Effect.runPromise(createProcessSession());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.live(
    'reconstructs both turns after a production resume that failed before it entered the run',
    () =>
      Effect.gen(function* () {
        const runId = '0aa1110aa111' as RunId;
        const config = runConfig('orchestrator');

        yield* closeTestSession(taskSession);
        const session = yield* openTestDefaultSession({
          roots: testWorkspaceRoots(),
        });
        taskSession = session;
        publishTestRunStart(session, runId);
        yield* session.log.settled;
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
        yield* session.log.settled;

        // The one fact a resume reads: the run's opening `run.position`.
        yield* seedRows(session.log)([
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
        yield* session.log.settled;

        // The resumed launch stops before it enters the run (no provider key
        // binds its model): it writes nothing and lets the claim go.
        expect(
          (yield* Effect.flip(resumeRun(runId, { session }))).message,
        ).toContain('Missing API key');

        expect(
          (yield* Effect.exit(
            session.log.transact([
              {
                type: 'log',
                aggregateId: qualifyAggregateId('run', runId),
                level: 'info',
                message: 'late stream write',
              },
            ]),
          ))._tag,
        ).toBe('Failure');
        expect(yield* session.log.owns(runId)).toBe(false);

        const archived = yield* readCompletedRunConversationEffect(
          runId,
          session,
        );
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
          run: { session: taskSession, runId, toolPolicy: {} },
          roots: taskSession.roots,
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
        expect(firstPage.output).toContain('Returned message interval: [0, 2)');
        expect(firstPage.output).toContain('Next offset: 2');
        expect(firstPage.output).not.toContain('Now prove the second lemma.');
        expect(secondPage.output).toContain(
          'Returned message interval: [2, 4)',
        );
        expect(secondPage.output).toContain('Next offset: none');
        expect(secondPage.output).not.toContain('Prove the first lemma.');
      }).pipe((program) => withProcessServices(testRuntime(), program)),
  );
});
