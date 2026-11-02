/**
 * The session store's transactions (`sessionStore.ts`) over a real store on
 * the validation model: a commit is answered once the session view shows
 * it, and the view is how every reader sees it.
 *
 * Failure modes (R24 of the harness 1.0 release acceptance):
 * - a transaction whose rows commit but whose view never shows them reports
 *   success to its caller, or leaves it waiting;
 * - the rows it committed are rolled back, or read as absent, by a later
 *   session over the same store.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import {
  AgentConfigSchema,
  generateRunId,
  qualifyAggregateId,
} from '@texra-ai/harness/schemas';
import { SessionRequests } from '@agent/runtime/requestPolicy';
import { rootRun } from '@agent/runtime/rootLaunch';
import { SessionViewAccess } from '@shared/session/runHistory';
import {
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { SessionGraph } from '@test/support/testKernel';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';

/** The titles the store holds for `runId`, oldest first. */
const titlesOf = (storage: string, runId: string) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.description')
    .map(
      (row) => (JSON.parse(row.data) as { description: string }).description,
    );

describe('session store transactions', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-store-'), { buildPerTest: true })((it) => {
      it.effect(
        'R24: a commit whose view never shows it fails its caller, and the committed rows stand',
        () =>
          Effect.gen(function* () {
            const roots = testWorkspaceRoots();
            const session = yield* persistentTestSession(roots);
            const runId = generateRunId();
            const release = join(roots.workspace!, 'release');
            yield* rootRun({
              config: Schema.decodeUnknownSync(AgentConfigSchema)({
                agent: 'command_runner',
                persona: {
                  name: 'command_runner',
                  description: 'Runs one command.',
                  prompt: `GOLDEN-APPROVAL bash until [ -e ${release} ]; do sleep 0.05; done`,
                  tools: ['bash'],
                },
                agentSource: 'inline',
                model: 'openai/gpt-5.6-sol',
                instruction: 'Run the command.',
              }),
              runId,
              approval: { delegated: true },
            }).pipe(Effect.provide(session));
            // A reader keeps the running run's transcript in the view.
            yield* Context.get(session, SessionViewAccess).subscribe('reader', [
              { id: qualifyAggregateId('run', runId), fromSeq: 0 },
            ]);
            yield* untilStored(roots.storage, (rows) =>
              rows.some(
                (row) => row.run === runId && row.type === 'tool.start',
              ),
            );
            // Every read the view's updater retries fails: it dies, so the
            // rename below commits but never reaches the view.
            const faults = yield* sessionStoreFaults(roots.storage);
            for (let read = 0; read < 6; read += 1)
              yield* faults.failNext('readInputBatch');

            const renamed = yield* Effect.exit(
              Context.get(session, SessionRequests)
                .request({
                  kind: 'run.rename',
                  runId,
                  title: 'Renamed by hand',
                })
                .pipe(Effect.provide(session), Effect.timeout('20 seconds')),
            );
            // The caller sees the view's death, not a refusal of the rename.
            expect(Exit.isFailure(renamed) && String(renamed.cause)).toContain(
              'injected readInputBatch fault',
            );
            // The committed title stands: in the store, and for a later session.
            expect(titlesOf(roots.storage, runId)).toContain('Renamed by hand');
            writeFileSync(release, '');
            yield* Sessions.use((sessions) => sessions.close(roots));
            const reopened = yield* persistentTestSession(roots);
            const view = yield* Context.get(reopened, SessionViewAccess).read(
              [],
            );
            expect(view.runs.get(runId)).toMatchObject({
              description: 'Renamed by hand',
              descriptionBy: 'user',
            });
          }),
      );
    });
  });
});
