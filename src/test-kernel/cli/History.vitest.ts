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
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

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
  MESSAGE_TYPES,
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
import { runHistoryExport } from '@cli/commands/history';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { initCliPlatform } from '@cli/runtime/initPlatform';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import type { TraceDocument } from '@texra-ai/harness/schemas';
import {
  cliHistoryDetailNdjsonRecord,
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  readCliHistoryStandaloneTemplate,
} from '@cli/runtime/history';
import { closeSessionOf } from '@test/support/sessionEnd';
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

// Tool-call nodes. `args` is passed through verbatim so callers can cover
// both JSON-string and object argument encodings.
function mockToolCallConversation(
  ...calls: ReadonlyArray<{ name: string; args: unknown }>
): void {
  mocks.readConversation.mockResolvedValue(
    calls.map(({ name, args }) => ({ kind: 'tool-call', name, input: args })),
  );
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

  it('projects the history-detail NDJSON status onto the frozen vocabulary', async () => {
    await publishRunFacts('c1c1c1' as RunId, {
      outcome: RUN_OUTCOME.FAILED,
    });

    const details = await historyDetails('c1c1c1' as RunId);
    expect(details?.status).toBe('failed');
    expect(cliHistoryDetailNdjsonRecord(details!)).toMatchObject({
      kind: 'history-detail',
      detail: { id: 'c1c1c1', status: 'error' },
    });
  });

  it('labels team runs by preset in history lists', async () => {
    const teamConfig = toolUseAgentConfig({
      agent: 'engineer',
      cli: { teamId: ' software-engineer ' },
    });
    // A chat that was stopped resumes.
    await publishRunFacts('bea111' as RunId, {
      record: teamConfig,
      outcome: RUN_OUTCOME.CANCELLED,
    });

    const entries = await historyEntries();

    expect(entries[0]?.agent).toBe('engineer');
    expect(entries[0]?.teamId).toBe('software-engineer');
    expect(formatCliHistoryText(entries)).toBe(
      `bea111\t${entries[0]?.timestamp}\tteam:software-engineer\tresumable\t-`,
    );
  });

  it('returns null for ids without a run view, config, or flow state', async () => {
    await expect(historyDetails('deadbe' as RunId)).resolves.toBeNull();
  });

  it.effect('finds a stamped diagnostic-only root in CLI history details', () =>
    Effect.gen(function* () {
      const runId = 'a11ce7a11ce7' as RunId;
      const session = testDefaultSession();
      publishTestRunStart(session, runId);
      session.log.publish(runId, {
        type: 'log',
        level: 'info',
        message: 'Root status only',
        messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      });
      yield* session.log.settled;
      // The run's own `run.start` plus the diagnostic-only transcript row
      // prove the run exists even though it yields no conversation.

      expect(yield* Effect.promise(() => historyDetails(runId))).toMatchObject({
        id: runId,
        status: 'unknown',
        conversationPreview: null,
      });
    }),
  );

  it('treats full-only conversation data as a found run', async () => {
    mocks.readConversation.mockResolvedValue([
      { kind: 'tool-call', name: 'bash', input: {} },
    ]);

    const details = await historyDetails('deadbe' as RunId, {
      includeFullConversation: true,
    });

    expect(details).toMatchObject({
      id: 'deadbe',
      status: 'unknown',
      conversationPreview: null,
      conversation: {
        messageCount: 1,
        messages: [
          {
            index: 1,
            role: 'assistant',
            content: '[tool_use: bash]',
            truncated: false,
          },
        ],
      },
    });
  });

  it('shows a bounded final assistant preview when no report is stored', async () => {
    mocks.readConversation.mockResolvedValue([
      {
        kind: 'user-message',
        parts: [{ type: 'text', text: 'Review the proof.' }],
      },
      { kind: 'assistant-text', text: '' },
      { kind: 'tool-result', text: 'problem.tex contents' },
      { kind: 'assistant-text', text: 'Final proof analysis.' },
      { kind: 'tool-call', name: 'read_file', input: {} },
    ]);

    const details = await historyDetails('a1a1a1' as RunId);
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.conversationPreview).toEqual({
      messageCount: 5,
      messages: [
        {
          index: 4,
          role: 'assistant',
          content: 'Final proof analysis.',
          truncated: false,
        },
      ],
    });
    expect(text).toContain(
      [
        'Conversation (5 messages; showing assistant message 4):',
        '',
        '[assistant #4]',
        'Final proof analysis.',
      ].join('\n'),
    );
    expect(text).not.toContain('problem.tex contents');
    expect(text).not.toContain('[tool_use: read_file]');
  });

  it('omits provider thinking from history previews', async () => {
    mocks.readConversation.mockResolvedValue([
      {
        kind: 'user-message',
        parts: [{ type: 'text', text: 'Polish the lemma.' }],
      },
      { kind: 'thinking', text: 'hidden chain of thought' },
      { kind: 'assistant-text', text: 'Final polished lemma.' },
    ]);

    const details = await historyDetails('a1a1a1' as RunId, {
      includeFullConversation: true,
    });
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.conversationPreview?.messages).toEqual([
      {
        index: 3,
        role: 'assistant',
        content: 'Final polished lemma.',
        truncated: false,
      },
    ]);
    expect(details?.conversation?.messages).toEqual([
      {
        index: 1,
        role: 'user',
        content: 'Polish the lemma.',
        truncated: false,
      },
      {
        index: 2,
        role: 'assistant',
        content: '[provider reasoning hidden]',
        truncated: false,
      },
      {
        index: 3,
        role: 'assistant',
        content: 'Final polished lemma.',
        truncated: false,
      },
    ]);
    expect(text).toContain('[assistant #3]\nFinal polished lemma.');
    expect(text).not.toContain('hidden chain of thought');
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

  it('still shows a child run asked for by explicit id', async () => {
    await publishRunFacts('de1e6a' as RunId, {
      parent: 'f00707' as RunId,
      outcome: RUN_OUTCOME.COMPLETED,
    });

    const details = await historyDetails('de1e6a' as RunId);

    expect(details?.id).toBe('de1e6a');
    expect(formatCliHistoryDetailsText(details!)).toContain('Parent: f00707');
  });

  it('surfaces persisted workspace files without parsing provider messages', async () => {
    const workspace = await makeTempDir('texra-history-', tempDirs);
    await writeFile(path.join(workspace, 'durable.md'), '# durable');
    await seedToolUseRun('a1a1a1' as RunId, workspace, ['durable.md']);
    mockToolCallConversation({
      name: 'write_file',
      args: JSON.stringify({ path: 'legacy.md' }),
    });

    const details = await historyDetails('a1a1a1' as RunId);

    expect(details?.files).toEqual([
      { path: 'workspace/durable.md', size: 9, isDirectory: false },
    ]);
  });

  it('preserves persisted paths inside a top-level workspace directory', async () => {
    const workspace = await makeTempDir('texra-history-', tempDirs);
    await mkdir(path.join(workspace, 'workspace'));
    await writeFile(path.join(workspace, 'review.md'), 'wrong');
    await writeFile(path.join(workspace, 'workspace', 'review.md'), 'nested');
    await seedToolUseRun('a1a1a1' as RunId, workspace, ['workspace/review.md']);

    const details = await historyDetails('a1a1a1' as RunId);

    expect(details?.files).toEqual([
      { path: 'workspace/workspace/review.md', size: 6, isDirectory: false },
    ]);
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

  it.live('deletes indexed executions and reports a later missing lookup', () =>
    Effect.acquireUseRelease(
      createTestSession(),
      (session) =>
        Effect.gen(function* () {
          const id = 'aabbcc' as RunId;
          publishTestRunStart(session, id);
          yield* session.log.settled;
          expect(
            yield* deleteCliHistory(testSessionOf(session), 'all'),
          ).toEqual({
            deleted: 'all',
            count: 1,
            active: [],
            failed: [],
          });
          expect(yield* deleteCliHistory(testSessionOf(session), id)).toEqual({
            deleted: 'one',
            id,
            found: false,
            status: 'not-found',
          });
        }),
      (session) => closeSessionOf(session),
    ),
  );

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

    it.effect(
      'reports "incomplete" (not "not_found") when conversation exists but config does not',
      () =>
        Effect.gen(function* () {
          mocks.readConversation.mockResolvedValue([
            { kind: 'assistant-text', text: 'hi' },
          ]);

          expect(
            yield* readCliHistoryExportInput(
              Effect.sync(historySession),
              'a1a1a1' as RunId,
            ),
          ).toEqual({ status: 'incomplete' });
        }),
    );

    it.effect(
      'reports "not_found" (not "incomplete") when the stored conversation is an empty array',
      () =>
        Effect.gen(function* () {
          // A stored-but-empty conversation array is truthy (`![]` is `false`),
          // so a naive `!conversation` check would treat it as "present" and
          // report 'incomplete' here — while `history show` builds no preview
          // from an empty array and, with config/meta also absent, reports the
          // same id as not found. The two commands must agree.
          mocks.readConversation.mockResolvedValue([]);

          expect(
            yield* readCliHistoryExportInput(
              Effect.sync(historySession),
              'facade' as RunId,
            ),
          ).toEqual({ status: 'not_found' });
          expect(
            yield* Effect.promise(() => historyDetails('facade' as RunId)),
          ).toBeNull();
        }),
    );

    it.live(
      'returns null instead of throwing when the default template is absent',
      () =>
        Effect.gen(function* () {
          const resourcesPath = yield* Effect.promise(() =>
            makeTempDir('texra-history-standalone-empty-', tempDirs),
          );

          expect(
            yield* readCliHistoryStandaloneTemplate(resourcesPath),
          ).toBeNull();
        }).pipe(Effect.provide(nodePlatformLayer)),
    );

    describe('runHistoryExport html', () => {
      // Capture every byte written so we can assert on exit code + wording
      // without the real bytes leaking to the test runner's own stdout/stderr.
      let stdout = '';
      let stderr = '';
      let stdoutSpy: ReturnType<typeof vi.spyOn>;
      let stderrSpy: ReturnType<typeof vi.spyOn>;

      const trace = {
        runId: 'a1a1a1',
        config,
        meta: null,
        entries: [],
        snapshot: { plan: null, usage: null },
        terminalStatus: null,
      } as unknown as TraceDocument;

      beforeEach(() => {
        stdout = '';
        stderr = '';
        mocks.assembleTrace.mockReturnValue(
          Effect.succeed({ status: 'ok', trace }),
        );
        stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
          stdout += chunk;
        });
        stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
          stderr += chunk;
        });
      });

      afterEach(() => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      });

      it.effect(
        'reports missing replayable roots without an empty sidecar list',
        () =>
          Effect.gen(function* () {
            mocks.assembleTrace.mockReturnValue(
              Effect.succeed({ status: 'streamLogs_missing' }),
            );

            // The command is a program now; the entry runs it on the process
            // runtime it installs, and here that is the harness's.
            const exitCode = yield* runHistoryExport(
              createTestCliContext({
                cwd: '/workspace',
                resourcesPath: '/resources',
              }),
              'a1a1a1' as RunId,
              'html',
            ).pipe(Effect.provide(nodePlatformLayer));

            expect(exitCode).toBe(CliExitCode.Usage);
            expect(stdout).toBe('');
            expect(stderr).toContain('no replayable run-root transcript');
            expect(stderr).not.toContain('sidecars (');
          }),
      );
    });
  });
});
