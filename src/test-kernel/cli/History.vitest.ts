import '@test/support/sessionGraphTestSetup';

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect, Schema } from 'effect';
import { it } from '@effect/vitest';
import { beforeEach, describe, expect } from 'vitest';
import type { RunRecord } from '@agent/core/definition/RunRecord';
import {
  cliHistoryNdjsonRecords,
  listCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';

import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';

import { createFakeHost, setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';
import { seedEditedFiles, seedRunRecord } from '@test/support/runRecordSeeds';

import { testDefaultSession } from '@test/support/defaultSessionTestSetup';

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

/** The process session the CLI's history readers open. */
const historySession = Effect.sync(() => testSessionOf(testDefaultSession()));

const historyEntries = () =>
  testRuntime().runPromise(listCliHistoryEntries(historySession));

const historyDetails = (id: RunId) =>
  testRuntime().runPromise(readCliHistoryDetails(historySession, id));

/**
 * Publish the run's listing facts into the process session, which is where
 * `history` reads them from (the session's `RunView`, the same one every
 * surface reads).
 */
async function publishRunFacts(
  runId: RunId,
  facts: {
    record: RunRecord;
    edited?: readonly string[];
    outcome?: RunOutcome;
  },
): Promise<void> {
  const session = testDefaultSession();
  publishTestRunStart(session, runId);
  await Effect.runPromise(session.log.settled);
  await Effect.runPromise(seedRunRecord(session, runId, facts.record));
  if (facts.edited)
    await Effect.runPromise(seedEditedFiles(session, runId, facts.edited));
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
  await Effect.runPromise(session.log.settled);
}

describe('CLI history runtime', () => {
  setupPlatform(async () => {
    const historyStoragePath = await makeTempDir(
      'texra-history-storage-',
      tempDirs,
    );
    return createFakeHost({
      storagePath: historyStoragePath,
      globalStoragePath: historyStoragePath,
    });
  });

  beforeEach(async () => {
    const { openTestDefaultSession, closeTestDefaultSession } =
      await import('@test/support/sessionEnd');
    await Effect.runPromise(closeTestDefaultSession);
    await Effect.runPromise(
      openTestDefaultSession({ roots: testWorkspaceRoots() }),
    );
  });

  it('projects NDJSON status onto the frozen pre-consolidation vocabulary', async () => {
    // Byte parity for the public stream (proposal gate G): terminal outcomes
    // emit as CliRunStatus ('interrupted'/'error'/'completed');
    // 'resumable' passes through. Internal entries keep RunOutcome. A
    // document task that ended is settled; one that has not, resumes.
    const outcomes = [
      ['b1b1b1', RUN_OUTCOME.CANCELLED],
      ['b2b2b2', RUN_OUTCOME.FAILED],
      ['b3b3b3', RUN_OUTCOME.COMPLETED],
      ['b4b4b4', undefined],
    ] as const;
    for (const [id, outcome] of outcomes)
      await publishRunFacts(id as RunId, {
        record: config,
        ...(outcome && { outcome }),
      });

    const entries = await historyEntries();
    const byId = (id: string) => entries.find((entry) => entry.id === id);
    expect(outcomes.map(([id]) => byId(id)?.status)).toEqual([
      'cancelled',
      'failed',
      'completed',
      'resumable',
    ]);
    expect(
      outcomes.map(
        ([id]) =>
          (
            cliHistoryNdjsonRecords(
              [byId(id)!],
              '2026-05-18T09:00:00.000Z',
            )[0] as { entry: { status: string } }
          ).entry.status,
      ),
    ).toEqual(['interrupted', 'error', 'completed', 'resumable']);
  });

  it('does not surface missing files or persisted paths outside the workspace', async () => {
    const root = await makeTempDir('texra-history-root-', tempDirs);
    const workspace = path.join(root, 'workspace');
    const outsidePath = path.join(root, 'outside.md');
    await mkdir(workspace);
    await writeFile(outsidePath, 'outside');
    // A stored tool-use run whose settled calls edited these paths.
    await publishRunFacts('a1a1a1' as RunId, {
      record: Schema.decodeUnknownSync(AgentConfigSchema)({
        ...config,
        script: null,
        inputFiles: [],
        outputFiles: [],
        workingDirectory: workspace,
      }),
      edited: ['../outside.md', outsidePath, 'missing.md'],
    });

    const details = await historyDetails('a1a1a1' as RunId);

    expect(details?.files).toEqual([]);
  });
});
