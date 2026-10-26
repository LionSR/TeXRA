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
  formatCliHistoryDetailsText,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryDetails,
  readCliHistoryExportInput,
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
        globalStorage: host.roots.globalStorage,
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

  it('formats history list rows with the stable tab-separated text shape', async () => {
    await publishRunFacts('a1a1a1' as RunId, {
      record: config,
      outcome: RUN_OUTCOME.COMPLETED,
    });

    const entries = await historyEntries();

    expect(formatCliHistoryText(entries)).toBe(
      `a1a1a1\t${entries[0]?.timestamp}\tcorrect\tcompleted\tintro.tex`,
    );
    expect(
      cliHistoryNdjsonRecords(entries, '2026-05-18T09:00:00.000Z'),
    ).toEqual([
      {
        kind: 'history-entry',
        ts: '2026-05-18T09:00:00.000Z',
        entry: entries[0],
      },
    ]);
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

  it('can show the full stored conversation for post-run inspection', async () => {
    const longToolOutput = `${'tool-output-line\n'.repeat(320)}done`;
    mocks.readConversation.mockResolvedValue([
      {
        kind: 'user-message',
        parts: [{ type: 'text', text: 'Review the proof.' }],
      },
      { kind: 'assistant-text', text: '' },
      { kind: 'tool-call', name: 'read_file', input: {} },
      { kind: 'tool-result', text: 'problem.tex contents' },
      { kind: 'tool-result', text: longToolOutput },
      { kind: 'assistant-text', text: 'Final proof analysis.' },
    ]);

    const details = await historyDetails('a1a1a1' as RunId, {
      includeFullConversation: true,
    });
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.conversationPreview?.messages).toEqual([
      {
        index: 6,
        role: 'assistant',
        content: 'Final proof analysis.',
        truncated: false,
      },
    ]);
    expect(details?.conversation).toEqual({
      messageCount: 6,
      messages: [
        {
          index: 1,
          role: 'user',
          content: 'Review the proof.',
          truncated: false,
        },
        {
          index: 3,
          role: 'assistant',
          content: '[tool_use: read_file]',
          truncated: false,
        },
        {
          index: 4,
          role: 'user',
          content: '[tool_result: problem.tex contents]',
          truncated: false,
        },
        {
          index: 5,
          role: 'user',
          content: `[tool_result: ${longToolOutput}]`,
          truncated: false,
        },
        {
          index: 6,
          role: 'assistant',
          content: 'Final proof analysis.',
          truncated: false,
        },
      ],
    });
    expect(text).toContain(
      'Conversation (6 messages; showing 5 non-empty messages):',
    );
    expect(text).toContain('[user #1]\nReview the proof.');
    expect(text).toContain('[assistant #3]\n[tool_use: read_file]');
    expect(text).toContain('[user #4]\n[tool_result: problem.tex contents]');
    expect(text).toContain(`[user #5]\n[tool_result: ${longToolOutput}]`);
    expect(text).not.toContain('...[truncated]');
    expect(text).toContain('[assistant #6]\nFinal proof analysis.');
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

  it('validates run id shape before command handlers use storage', () => {
    expect(parseCliHistoryId('abc123')).toBe('abc123');
    expect(parseCliHistoryId('../abc123')).toBeUndefined();
  });
  describe('history export (--export)', () => {
    it.effect(
      'builds export input from the stored config, conversation, and run facts',
      () =>
        Effect.gen(function* () {
          const runId = 'a1a1a1' as RunId;
          mocks.readConversation.mockResolvedValue([
            {
              kind: 'user-message',
              parts: [{ type: 'text', text: 'Polish the lemma.' }],
            },
            { kind: 'assistant-text', text: 'Done.' },
          ]);
          const session = yield* Effect.promise(() =>
            publishRunFacts(runId, {
              record: config,
              description: 'Polish pass',
            }),
          );
          // The export stamps the run's own launch time, which the publisher
          // stamped on `run.start`.
          const launchedAt = (yield* session.view.read([])).runs.get(
            runId,
          )?.launchedAt;

          const result = yield* readCliHistoryExportInput(
            Effect.sync(historySession),
            runId,
          );

          expect(result).toEqual({
            status: 'ok',
            exportInput: {
              timestamp: new Date(launchedAt!).toISOString(),
              description: 'Polish pass',
              config: {
                agent: 'correct',
                model: 'deepseek/deepseek-v4-flash',
                instruction: 'Polish the introduction.',
                inputFiles: ['chapters/intro.tex'],
                mediaFiles: [],
                contextFiles: [],
                outputFiles: ['chapters/intro.tex'],
              },
              nodes: [
                {
                  kind: 'user-message',
                  parts: [{ type: 'text', text: 'Polish the lemma.' }],
                },
                { kind: 'assistant-text', text: 'Done.' },
              ],
            },
          });
        }),
    );

    it.effect(
      'reports "not_found" only when there is no trace of the run at all',
      () =>
        Effect.gen(function* () {
          expect(
            yield* readCliHistoryExportInput(
              Effect.sync(historySession),
              'facade' as RunId,
            ),
          ).toEqual({ status: 'not_found' });
        }),
    );

    it.effect(
      'reports "incomplete" (not "not_found") when config exists but conversation does not',
      () =>
        Effect.gen(function* () {
          // history show would still display this run (it has a config) —
          // export just has nothing to render, which is a different failure than
          // the id not resolving to anything at all: a stored config, no
          // conversation.
          yield* Effect.promise(() =>
            publishRunFacts('a1a1a1' as RunId, { record: config }),
          );
          expect(
            yield* readCliHistoryExportInput(
              Effect.sync(historySession),
              'a1a1a1' as RunId,
            ),
          ).toEqual({ status: 'incomplete' });
        }),
    );
  });
});
