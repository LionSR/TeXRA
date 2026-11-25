/**
 * The session store's transactions (`sessionStore.ts`) over a real store on
 * the validation model: a commit is answered once the session view shows
 * it, and the view is how every reader sees it. A run's result also waits
 * for the session's reader of committed rows (`settled`) to run over the
 * run's end.
 *
 * Failure modes:
 * - R24 of the harness 1.0 release acceptance: a transaction whose rows
 *   commit but whose view never shows them reports success to its caller,
 *   or leaves it waiting; the rows it committed are rolled back, or read as
 *   absent, by a later session over the same store.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Schema, Stream } from 'effect';
import { assert, describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/worldline';
import { AgentConfigSchema, generateRunId } from '@texra-ai/worldline/schemas';
import { SessionRequests } from '@agent/runtime/requests';
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
import { FakeHost, SessionGraph } from '@test/support/testKernel';

/** The titles the store holds for `runId`, oldest first. */
const titlesOf = (storage: string, runId: string) =>
  storedRows(storage)
    .filter((row) => row.run === runId && row.type === 'run.description')
    .map(
      (row) =>
        Schema.decodeUnknownSync(Schema.Struct({ description: Schema.String }))(
          JSON.parse(row.data),
        ).description,
    );

describe('session store transactions', { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-store-'), { buildPerTest: true })((it) => {
      it.effect(
        'R24: a commit whose view never shows it fails its caller, and the committed rows stand',
        () =>
          Effect.gen(function* () {
            const { roots } = yield* FakeHost;
            const session = yield* persistentTestSession(roots);
            const runId = generateRunId();
            assert(roots.workspace !== undefined, 'no test workspace');
            const release = join(roots.workspace, 'release');
            yield* rootRun({
              config: Schema.decodeUnknownSync(AgentConfigSchema)({
                label: 'command_runner',
                system: `GOLDEN-APPROVAL bash until [ -e ${release} ]; do sleep 0.05; done`,
                tools: ['bash'],
                model: 'openai/gpt-5.6-sol',
                instruction: 'Run the command.',
              }),
              runId,
              approval: 'autoApprove',
            }).pipe(Effect.provide(session));
            // A reader keeps the running run's transcript in the view.
            yield* Context.get(session, SessionViewAccess).subscribe([
              { id: runId, fromSeq: 0 },
            ]);
            yield* untilStored(roots.storage, (rows) =>
              rows.some(
                (row) => row.run === runId && row.type === 'tool.intent',
              ),
            );
            // Every read the view's updater retries fails: a second reader's
            // set makes it replay, it dies, so the rename below commits but
            // never reaches the view.
            const faults = yield* sessionStoreFaults(roots.storage);
            for (let read = 0; read < 6; read += 1)
              yield* faults.failNext('readInputBatch');
            yield* Context.get(session, SessionViewAccess).subscribe([
              { id: runId, fromSeq: 0 },
              { id: generateRunId(), fromSeq: 0 },
            ]);
            // The view is dead before the rename asks: the request's own
            // read of the log must not take the faults meant for it.
            yield* Effect.exit(
              Stream.runDrain(Context.get(session, SessionViewAccess).changes),
            );

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
            });
          }),
      );
    });
  });
});
