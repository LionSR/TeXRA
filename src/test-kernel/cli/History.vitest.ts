// Test composition imports
import '@test/support/sessionGraphTestSetup';
// `runHistoryExport` calls `initCliPlatform` unconditionally; the real one
// bootstraps platform agent directories keyed by `resourcesPath`, which is
// unrelated to (and heavier than) what these tests exercise.
import '@test/support/cliInitPlatformMock';

/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect, Schema } from 'effect';
import { it } from '@effect/vitest';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';

import { beforeEach, describe, expect, vi } from 'vitest';

import type { ExportNode, LocalSession } from '@texra-ai/harness';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';

import {
  createFakeHost,
  installedHost,
  setupPlatform,
} from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { asDocumentTask } from '@test/support/ProgressControllerHarnesses';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  emptyRunEndOutput,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import type { RunRecord } from '@agent/core/definition/RunRecord';
import { seedEditedFiles, seedRunRecord } from '@test/support/runRecordSeeds';
import type { CliProcessRuntime } from '@cli/runtime/cliProcessRuntime';

const mocks = vi.hoisted(() => ({
  readConversation: vi.fn(),
  assembleTrace: vi.fn(),
}));

/**
 * The default test session, its trace and conversation reads answered by
 * the suite's mocks: `readConversation` resolves the conversation, or null
 * for the session's own read.
 */
const historySession = (): LocalSession => {
  const session = testSessionOf(testDefaultSession());
  return {
    ...session,
    records: (runId) => {
      const records = session.records(runId);
      return {
        ...records,
        readTrace: () => mocks.assembleTrace(runId, session),
        readConversation: () =>
          Effect.flatMap(
            Effect.promise((): Promise<ExportNode[] | null> =>
              mocks.readConversation(),
            ),
            (conversation) =>
              conversation === null
                ? records.readConversation()
                : Effect.succeed(conversation),
          ),
      };
    },
  };
};

// The CLI modules under test, over the mocks registered above.
import { initCliPlatform } from '@cli/runtime/initPlatform';
import {
  cliHistoryNdjsonRecords,
  listCliHistoryEntries,
  readCliHistoryDetails,
} from '@cli/runtime/history';
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

// `readCliHistoryDetails` over the fake host this suite installs, the way the
// CLI composition root threads its own stores in.
function historyDetails(
  id: RunId,
  options?: { includeFullConversation?: boolean },
) {
  return testRuntime().runPromise(
    readCliHistoryDetails(Effect.sync(historySession), id, options),
  );
}

// The same open, for the listing the CLI's `history list` run arm runs.
function historyEntries() {
  return testRuntime().runPromise(
    listCliHistoryEntries(Effect.sync(historySession)),
  );
}

// An internal tool-use agent config with no input/output files, built from
// the base `config` with per-test field overrides.
function toolUseAgentConfig(
  overrides: Record<string, unknown> = {},
): typeof config {
  return Schema.decodeUnknownSync(AgentConfigSchema)({
    ...config,
    script: null,
    inputFiles: [],
    outputFiles: [],
    ...overrides,
  });
}

// A stored tool-use run in `workspace` whose settled calls edited `edited`.
async function seedToolUseRun(
  runId: RunId,
  workspace: string,
  edited: readonly string[],
): Promise<void> {
  await publishRunFacts(runId, {
    record: toolUseAgentConfig({ workingDirectory: workspace }),
    edited,
  });
}

/**
 * Publish the run's listing facts into the process session, which is where
 * `history` reads them from (the session's `RunView`, the same one every
 * surface reads). Returns
 * the session so a caller can read back a fact the publisher stamps, such as
 * `launchedAt`.
 */
async function publishRunFacts(
  runId: RunId,
  facts: {
    parent?: RunId;
    record?: RunRecord;
    edited?: readonly string[];
    description?: string;
    outcome?: RunOutcome;
  } = {},
): Promise<SessionHandle> {
  const session = testDefaultSession();
  if (facts.parent) publishTestRunStart(session, facts.parent);
  publishTestRunStart(session, runId, { parent: facts.parent ?? null });
  await Effect.runPromise(session.log.settled);
  if (facts.record)
    await Effect.runPromise(seedRunRecord(session, runId, facts.record));
  if (facts.edited)
    await Effect.runPromise(seedEditedFiles(session, runId, facts.edited));
  if (facts.description !== undefined) {
    publishTestRows(session, [
      {
        type: 'run.description',
        by: 'model',
        aggregateId: qualifyAggregateId('run', runId),
        description: facts.description,
      },
    ]);
  }
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
  return session;
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
    vi.clearAllMocks();
    const host = installedHost();
    vi.mocked(initCliPlatform).mockReturnValue(
      Effect.succeed({
        ...host.platform,
        host: host.roots.host,
        config: host.roots.config,
        workspaceState: host.roots.workspaceState,
        repoState: host.roots.repoState,
        globalState: host.roots.globalState,
        secrets: host.secrets,
        session: Effect.sync(historySession),
        roots: host.roots,
        // The history command reads no `Sessions` or `CliEditors` from it.
        runtime: testRuntime() as CliProcessRuntime,
      }),
    );
    mocks.readConversation.mockResolvedValue(null);
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
            cliHistoryNdjsonRecords([byId(id)!])[0] as {
              entry: { status: string };
            }
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
    await seedToolUseRun('a1a1a1' as RunId, workspace, [
      '../outside.md',
      outsidePath,
      'missing.md',
    ]);

    const details = await historyDetails('a1a1a1' as RunId);

    expect(details?.files).toEqual([]);
  });
});
