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
 *   absent, by a later session over the same store;
 * - a plugin fact kind's `writes` callback that throws stops that reader:
 *   the result of the run that committed the fact, and of every later run
 *   in the session, fails instead of arriving, and no later run's files are
 *   announced.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

import { layer } from '@effect/vitest';
import { Context, Effect, Exit, Layer, PubSub, Schema } from 'effect';
import { describe, expect } from 'vitest';

import { Sessions } from '@texra-ai/harness';
import {
  definePlugin,
  defineTool,
  AppSignals,
} from '@texra-ai/harness/plugins';
import {
  AgentConfigSchema,
  generateRunId,
  qualifyAggregateId,
} from '@texra-ai/harness/schemas';
import { SessionRequests } from '@agent/runtime/requests';
import { rootRun } from '@agent/runtime/rootLaunch';
import { validationModelLayer } from '@cli/runtime/models/validationModel';
import { SessionViewAccess } from '@shared/session/runHistory';
import {
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  sessionStoreFaults,
  storedRows,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph, TestSession } from '@test/support/testKernel';

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

/** The file every notes fact names. */
const NOTED_FILE = '/workspace/notes.tex';

/**
 * A plugin with one tool per fact kind, each call committing a fact that
 * names {@link NOTED_FILE}: `note_broken` a `notes/broken` one, whose
 * `writes` callback throws, and `note_written` a `notes/written` one, whose
 * callback returns the file.
 */
const notesPlugin = definePlugin({
  id: 'notes',
  tools: (['broken', 'written'] as const).map((kind) =>
    defineTool({
      name: `note_${kind}`,
      description: `Record a ${kind} note.`,
      schema: Schema.Struct({}),
      execute: () =>
        Effect.succeed({
          status: 'executed' as const,
          output: 'Noted.',
          facts: [{ plugin: 'notes', kind, version: 1, value: NOTED_FILE }],
        }),
    }),
  ),
  factKinds: [
    {
      plugin: 'notes',
      kind: 'broken',
      version: 1,
      schema: Schema.String,
      fork: 'drop',
      writes: () => {
        throw new Error('The notes plugin lost track of its files.');
      },
    },
    {
      plugin: 'notes',
      kind: 'written',
      version: 1,
      schema: Schema.String,
      fork: 'drop',
      writes: (value) => [Schema.decodeUnknownSync(Schema.String)(value)],
    },
  ],
});

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
            if (roots.workspace === undefined)
              throw new Error('no test workspace');
            const release = join(roots.workspace, 'release');
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
              approval: 'autoApprove',
            }).pipe(Effect.provide(session));
            // A reader keeps the running run's transcript in the view.
            yield* Context.get(session, SessionViewAccess).subscribe([
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

  // The harness's process, with the notes plugin beside its built-ins.
  layer(
    Layer.provideMerge(
      SessionGraph.with([notesPlugin], validationModelLayer),
      FakeHost.layer(),
    ),
    { excludeTestServices: true },
  )('over a plugin whose write callback throws', (it) => {
    it.layer(validationHost('texra-notes-'), { buildPerTest: true })((it) => {
      it.effect(
        "a fact whose write callback throws fails neither its run's result nor a later run's, and the later run's file is announced",
        () =>
          Effect.gen(function* () {
            // Subscribed before the runs start, so it holds every signal
            // they publish.
            const signals = yield* (yield* AppSignals).subscribe;
            const session = yield* TestSession.open(undefined, {
              persistent: true,
            });
            // The validation model's approval script, for a tool that asks
            // for no approval: the persona's turn calls the tool named after
            // the marker, then answers.
            const note = (kind: 'broken' | 'written') =>
              session
                .start({
                  agent: {
                    name: `${kind}_noter`,
                    description: `Records a ${kind} note.`,
                    prompt: `GOLDEN-APPROVAL note_${kind}`,
                    tools: [`note_${kind}`],
                  },
                  instruction: 'Record the note.',
                  model: 'openai/gpt-5.6-sol',
                })
                .pipe(Effect.flatMap((run) => run.result));

            expect((yield* note('broken')).outcome).toBe('completed');
            expect((yield* note('written')).outcome).toBe('completed');
            // Each result arrives once the session's reader has run over its
            // run's rows, so the reader has seen both facts by now: only the
            // written one's callback returned a file.
            const published = yield* PubSub.takeUpTo(
              signals,
              Number.POSITIVE_INFINITY,
            );
            expect(
              published.flatMap(({ signal, payload }) =>
                signal === 'workspaceFilesWritten' ? [payload] : [],
              ),
            ).toEqual([{ absolutePaths: [NOTED_FILE] }]);
          }),
      );
    });
  });
});
