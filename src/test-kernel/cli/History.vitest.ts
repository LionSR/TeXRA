import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect, Schema, Context } from 'effect';
import { layer } from '@effect/vitest';
import { expect } from 'vitest';
import {
  AgentConfigSchema,
  emptyRunEndOutput,
  qualifyAggregateId,
  RUN_OUTCOME,
  RunIdSchema,
  type RunId,
  type RunOutcome,
  type RunRecord,
} from '@texra-ai/harness/schemas';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import {
  cliHistoryNdjsonRecords,
  listCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import { SessionLog } from '@shared/session/runHistory';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { createFakeHost } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';
import { seedEditedFiles, seedRunRecord } from '@test/support/runRecordSeeds';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

const config = Schema.decodeUnknownSync(AgentConfigSchema)(
  asDocumentTask({
    agent: 'correct',
    model: 'deepseek/deepseek-v4-flash',
    instruction: 'Polish the introduction.',
    inputFiles: ['chapters/intro.tex'],
    outputFiles: ['chapters/intro.tex'],
  }),
);

const tempDirs = useTempDirs();

const decodeRunId = Schema.decodeUnknownSync(RunIdSchema);

/** The CLI's history reads over the process session, as a chat no service
 *  serves holds them. */
const historyEntries = Effect.flatMap(TestSession, listCliHistoryEntries);

const historyDetails = (id: RunId) =>
  Effect.flatMap(TestSession, (session) =>
    readCliHistoryDetails(session, session.roots.storage, id),
  );

/**
 * Publish the run's listing facts into the process session, which is where
 * `history` reads them from (the session's `RunView`, the same one every
 * surface reads).
 */
const publishRunFacts = (
  session: Context.Context<SessionServices>,
  runId: RunId,
  facts: {
    record: RunRecord;
    edited?: readonly string[];
    outcome?: RunOutcome;
  },
) =>
  Effect.gen(function* () {
    publishTestRunStart(session, runId);
    yield* Context.get(session, SessionLog).settled;
    yield* seedRunRecord(session, runId, facts.record);
    if (facts.edited) yield* seedEditedFiles(session, runId, facts.edited);
    if (facts.outcome) {
      publishTestRows(session, [
        {
          type: 'run.end',
          aggregateId: qualifyAggregateId('run', runId),
          outcome: facts.outcome,
          output: emptyRunEndOutput(),
        },
      ]);
    }
    yield* Context.get(session, SessionLog).settled;
  });

// Live clock: the history readers run as the command runs them.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'CLI history runtime',
  (it) => {
    // Per case: a host whose storage is a temp directory of its own, and
    // the process session over that store.
    it.layer(
      FakeHost.layer(async () => {
        const historyStoragePath = await makeTempDir(
          'texra-history-storage-',
          tempDirs,
        );
        return createFakeHost({
          storagePath: historyStoragePath,
          globalStoragePath: historyStoragePath,
        });
      }),
      { buildPerTest: true },
    )((it) => {
      it.layer(TestSession.layer(testWorkspaceRoots(), { persistent: true }))(
        (it) => {
          it.effect(
            "carries each run's outcome and resumability, in NDJSON too",
            () =>
              Effect.gen(function* () {
                // The record states the outcome the run ended on (null for
                // none) beside whether a resume continues it. A document task
                // that ended is settled; one that has not, resumes.
                const session = yield* Effect.flatMap(
                  TestSession,
                  sessionHandleOf,
                );
                const outcomes = [
                  ['b1b1b1', RUN_OUTCOME.CANCELLED],
                  ['b2b2b2', RUN_OUTCOME.FAILED],
                  ['b3b3b3', RUN_OUTCOME.COMPLETED],
                  ['b4b4b4', undefined],
                ] as const;
                for (const [id, outcome] of outcomes)
                  yield* publishRunFacts(session, decodeRunId(id), {
                    record: config,
                    ...(outcome && { outcome }),
                  });

                const entries = yield* historyEntries;
                const byId = (id: string) =>
                  entries.find((entry) => entry.id === id);
                expect(
                  outcomes.map(([id]) => [
                    byId(id)?.outcome,
                    byId(id)?.resumable,
                  ]),
                ).toEqual([
                  ['cancelled', false],
                  ['failed', false],
                  ['completed', false],
                  [null, true],
                ]);
                const listed = outcomes.flatMap(([id]) => byId(id) ?? []);
                expect(cliHistoryNdjsonRecords(listed)).toMatchObject(
                  ['cancelled', 'failed', 'completed', null].map((outcome) => ({
                    entry: { outcome },
                  })),
                );
              }),
          );

          it.effect(
            'does not surface missing files or persisted paths outside the workspace',
            () =>
              Effect.gen(function* () {
                const session = yield* Effect.flatMap(
                  TestSession,
                  sessionHandleOf,
                );
                const root = yield* Effect.promise(() =>
                  makeTempDir('texra-history-root-', tempDirs),
                );
                const workspace = path.join(root, 'workspace');
                const outsidePath = path.join(root, 'outside.md');
                yield* Effect.promise(() => mkdir(workspace));
                yield* Effect.promise(() => writeFile(outsidePath, 'outside'));
                // A stored tool-use run whose settled calls edited these
                // paths.
                yield* publishRunFacts(session, decodeRunId('a1a1a1'), {
                  record: Schema.decodeUnknownSync(AgentConfigSchema)({
                    ...config,
                    script: null,
                    inputFiles: [],
                    outputFiles: [],
                    workingDirectory: workspace,
                  }),
                  edited: ['../outside.md', outsidePath, 'missing.md'],
                });

                const details = yield* historyDetails(decodeRunId('a1a1a1'));

                expect(details?.files).toEqual([]);
              }),
          );
        },
      );
    });
  },
);
