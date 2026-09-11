// Test composition imports
import '@test/support/sessionGraphTestSetup';

/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { Effect } from 'effect';
import { it as effectIt } from '@effect/vitest';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeHost, setupPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import {
  aggregateId,
  AgentCategory,
  emptyRunEndOutput,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@shared/schemas';
import type { SessionHandle } from '@agent/runtime/SessionHandle';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readConversation: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  readResultMeta: vi.fn(),
  readRunEnd: vi.fn(),
  readReport: vi.fn(),
  exists: vi.fn(),
  listRuns: vi.fn(),
  readCliResumedModel: vi.fn(),
  assembleTrace: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    getRunRecords: vi.fn(() => ({
      readConfig: () => Effect.tryPromise(() => mocks.readConfig()),
      readWorkspaceFiles: () =>
        Effect.tryPromise(() => mocks.readWorkspaceFiles()),
      readResultMeta: () => Effect.tryPromise(() => mocks.readResultMeta()),
      readRunEnd: () => Effect.tryPromise(() => mocks.readRunEnd()),
      readReport: () => Effect.tryPromise(() => mocks.readReport()),
    })),
    listRuns: mocks.listRuns,
  };
});

// `isCliRunResumable` stays real: it is the rule under test on both surfaces,
// and it decides from the row's own facts without touching storage.
vi.mock('@cli/runtime/toolUseResumeData', async () => {
  const actual = await vi.importActual<
    typeof import('@cli/runtime/toolUseResumeData')
  >('@cli/runtime/toolUseResumeData');
  return {
    ...actual,
    readCliResumedModel: () =>
      Effect.tryPromise(() => mocks.readCliResumedModel()),
  };
});

vi.mock('@transcript', async () => {
  const actual =
    await vi.importActual<typeof import('@transcript')>('@transcript');
  return {
    ...actual,
    assembleTrace: mocks.assembleTrace,
    readCompletedRunConversation: vi.fn((...args: unknown[]) =>
      Effect.gen(function* () {
        const conversation = yield* Effect.promise(() =>
          mocks.readConversation(),
        );
        return conversation === null
          ? yield* actual.readCompletedRunConversation(
              ...(args as Parameters<
                typeof actual.readCompletedRunConversation
              >),
            )
          : { conversation, source: 'streamLog' };
      }),
    ),
  };
});

// `runHistoryExport` calls this unconditionally; the real implementation
// bootstraps platform agent directories keyed by `resourcesPath`, which is
// unrelated to (and heavier than) what these tests exercise.
vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: vi.fn(),
}));

// Imported after vi.mock so the mocked dependencies are in place.
import { parseHistoryListLimit, runHistoryExport } from '@cli/commands/history';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import type { TraceDocument } from '@transcript';
import {
  cliHistoryDetailNdjsonRecord,
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryNotFoundText,
  formatCliHistoryText,
  formatInvalidExportFormatText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  readCliHistoryStandaloneTemplate,
  stageCliHistoryTraceViewerAssets,
} from '@cli/runtime/history';

const config = AgentConfigSchema.parse({
  agent: 'correct',
  model: 'deepseekT',
  instruction: 'Polish the introduction.',
  agentCategory: 'workflow',
  inputFiles: ['chapters/intro.tex'],
  outputFiles: ['chapters/intro.tex'],
});

const tempDirs = useTempDirs();

// An internal tool-use agent config with no input/output files, built from
// the base `config` with per-test field overrides.
function toolUseAgentConfig(
  overrides: Record<string, unknown> = {},
): typeof config {
  return AgentConfigSchema.parse({
    ...config,
    agentCategory: 'toolUse',
    inputFiles: [],
    outputFiles: [],
    ...overrides,
  });
}

function mockToolUseWorkspace(workspace: string): void {
  mocks.readConfig.mockResolvedValue({
    ...config,
    agentCategory: 'toolUse',
    workingDirectory: workspace,
  });
}

// A fresh temp directory mocked as the run's tool-use working directory.
async function useTempWorkspace(prefix = 'texra-history-'): Promise<string> {
  const workspace = await makeTempDir(prefix, tempDirs);
  mockToolUseWorkspace(workspace);
  return workspace;
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

// No persisted config, conversation, or flow state, and no run in the
// session's view: the run id resolves to nothing unless the test re-mocks one
// of these afterwards, or publishes the run's facts.
function mockNothingPersisted(): void {
  mocks.readConfig.mockResolvedValue(null);
  mocks.readConversation.mockResolvedValue(null);
  mocks.exists.mockResolvedValue(false);
}

/**
 * Publish the run's listing facts into the process session, which is where
 * `history` reads them from (the fold's `RunView`, one run model R3). Returns
 * the session so a caller can read back a fact the publisher stamps, such as
 * `launchedAt`.
 */
async function publishRunFacts(
  runId: RunId,
  facts: {
    parent?: RunId;
    description?: string;
    outcome?: RunOutcome;
  } = {},
): Promise<SessionHandle> {
  const { defaultSession } = await import('@agent/runtime/SessionHandle');
  const session = defaultSession();
  if (facts.parent) publishTestRunStart(session, facts.parent);
  publishTestRunStart(session, runId, { parent: facts.parent ?? null });
  if (facts.description !== undefined) {
    session.publish([
      {
        type: 'run.description',
        aggregateId: aggregateId('run', runId),
        description: facts.description,
      },
    ]);
  }
  if (facts.outcome) {
    session.publish([
      {
        type: 'run.end',
        aggregateId: aggregateId('run', runId),
        outcome: facts.outcome,
        output: emptyRunEndOutput(AgentCategory.ToolUse),
      },
    ]);
  }
  await session.settlePublications();
  return session;
}

// A completed agent-run listing row for the default `config`, with overrides
// for the fields a test cares about.
function runListEntry(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: 'run',
    identity: { kind: 'agent', agent: 'correct' },
    id: id as RunId,
    timestamp: '2026-05-18T08:00:00.000Z',
    record: config,
    outcome: 'completed',
    ...overrides,
  };
}

// The durable fact that makes a listing row resumable: a checkpoint on disk.
const RESUMABLE_ROW_FACTS = {
  checkpointPresent: true,
};

// A fresh temp directory to point --assets-dir at.
async function makeAssetsDestDir(prefix: string): Promise<string> {
  const cwd = await makeTempDir(prefix, tempDirs);
  return path.join(cwd, 'shared-assets');
}

// The minimal bundled trace-viewer: just an index.html.
async function writeViewerBundle(resourcesPath: string): Promise<void> {
  const viewerDir = path.join(resourcesPath, 'traceViewer');
  await mkdir(viewerDir, { recursive: true });
  await writeFile(path.join(viewerDir, 'index.html'), '<html></html>');
}

describe('CLI history runtime', () => {
  setupPlatform(async () => {
    const historyStoragePath = await makeTempDir(
      'texra-history-storage-',
      tempDirs,
    );
    return createFakeHost(
      {
        storagePath: historyStoragePath,
        globalStoragePath: historyStoragePath,
      },
      { fs: nodeFilesystem },
    );
  });

  beforeEach(async () => {
    const { initializeDefaultSession, teardownDefaultSession } =
      await import('@agent/runtime/SessionHandle');
    teardownDefaultSession();
    initializeDefaultSession({});
    vi.clearAllMocks();
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readRunEnd.mockResolvedValue(null);
    mocks.readReport.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);
    mocks.readCliResumedModel.mockResolvedValue(undefined);
  });

  it('formats history list rows with the stable tab-separated text shape', async () => {
    mocks.listRuns.mockReturnValue(Effect.succeed([runListEntry('a1a1a1')]));

    const entries = await listCliHistoryEntries();

    expect(formatCliHistoryText(entries)).toBe(
      'a1a1a1\t2026-05-18T08:00:00.000Z\tcorrect\tcompleted\tintro.tex',
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
    // The listing reads no resume data at all: `resumable` comes from the
    // checkpoint stat the listing already carries.
    expect(mocks.readCliResumedModel).not.toHaveBeenCalled();
  });

  it('projects NDJSON status onto the frozen pre-consolidation vocabulary', async () => {
    // Byte parity for the public stream (proposal gate G): terminal outcomes
    // emit as CliRunStatus ('interrupted'/'error'/'completed');
    // 'resumable'/'unknown' pass through. Internal entries keep RunOutcome.
    mocks.listRuns.mockReturnValue(
      Effect.succeed(
        (
          [
            ['b1', 'cancelled'],
            ['b2', 'failed'],
            ['b3', 'completed'],
            ['b4', undefined],
          ] as const
        ).map(([id, outcome]) => ({
          kind: 'run',
          identity: { kind: 'agent', agent: 'correct' },
          id: id as RunId,
          timestamp: '2026-05-18T08:00:00.000Z',
          record: config,
          ...(outcome ? { outcome } : {}),
        })),
      ),
    );

    const entries = await listCliHistoryEntries();
    expect(entries.map((entry) => entry.status)).toEqual([
      'cancelled',
      'failed',
      'completed',
      'unknown',
    ]);
    expect(
      cliHistoryNdjsonRecords(entries, '2026-05-18T09:00:00.000Z').map(
        (record) => (record as { entry: { status: string } }).entry.status,
      ),
    ).toEqual(['interrupted', 'error', 'completed', 'unknown']);
  });

  it('projects the history-detail NDJSON status onto the frozen vocabulary', async () => {
    await publishRunFacts('c1c1c1' as RunId, {
      outcome: RUN_OUTCOME.CANCELLED,
    });

    const details = await readCliHistoryDetails('c1c1c1' as RunId);
    expect(details?.status).toBe('cancelled');
    expect(cliHistoryDetailNdjsonRecord(details!)).toMatchObject({
      kind: 'history-detail',
      detail: { id: 'c1c1c1', status: 'interrupted' },
    });
  });

  it('hides internal process-bookkeeping and configless entries from the history list', async () => {
    const processConfig = toolUseAgentConfig({ agent: 'bash' });
    mocks.listRuns.mockReturnValue(
      Effect.succeed([
        runListEntry('visible'),
        {
          kind: 'run',
          identity: { kind: 'process', tool: 'bash' },
          id: 'bash-process' as RunId,
          timestamp: '2026-05-18T08:01:00.000Z',
          record: processConfig,
          outcome: 'completed',
        },
        {
          kind: 'incomplete',
          id: 'configless' as RunId,
          timestamp: '2026-05-18T08:02:00.000Z',
          outcome: 'completed',
        },
      ]),
    );

    const entries = await listCliHistoryEntries();

    expect(entries.map((entry) => entry.id)).toEqual(['visible']);
  });

  it('hides agent-spawned child runs from the history list', async () => {
    mocks.listRuns.mockReturnValue(
      Effect.succeed([
        runListEntry('root'),
        runListEntry('de1e6a', {
          timestamp: '2026-05-18T08:01:00.000Z',
          parentRunId: 'root' as RunId,
        }),
      ]),
    );

    const entries = await listCliHistoryEntries();

    expect(entries.map((entry) => entry.id)).toEqual(['root']);
  });

  it('labels multi-agent team runs by preset in history lists', async () => {
    const teamConfig = toolUseAgentConfig({
      agent: 'engineer',
      cli: { multiAgentPresetId: ' software-engineer ' },
    });
    mocks.listRuns.mockReturnValue(
      Effect.succeed([
        runListEntry('bea111', {
          identity: { kind: 'agent', agent: 'engineer' },
          timestamp: '2026-05-18T10:00:00.000Z',
          record: teamConfig,
          outcome: 'cancelled',
          ...RESUMABLE_ROW_FACTS,
        }),
      ]),
    );

    const entries = await listCliHistoryEntries();

    expect(entries[0]?.agent).toBe('engineer');
    expect(entries[0]?.teamPresetId).toBe('software-engineer');
    expect(formatCliHistoryText(entries)).toBe(
      'bea111\t2026-05-18T10:00:00.000Z\tteam:software-engineer\tresumable\t-',
    );
  });

  it('uses the history description for no-input chat rows', async () => {
    const chatConfig = toolUseAgentConfig({ agent: 'assistant' });
    mocks.listRuns.mockReturnValue(
      Effect.succeed([
        runListEntry('chat1', {
          identity: { kind: 'agent', agent: 'assistant' },
          timestamp: '2026-05-18T11:00:00.000Z',
          record: chatConfig,
          outcome: 'cancelled',
          description: 'Sketch a proof outline',
          ...RESUMABLE_ROW_FACTS,
        }),
      ]),
    );

    const entries = await listCliHistoryEntries();

    expect(formatCliHistoryText(entries)).toBe(
      'chat1\t2026-05-18T11:00:00.000Z\tassistant\tresumable\tSketch a proof outline',
    );
  });

  it('parses positive history list limits', () => {
    expect(parseHistoryListLimit('1')).toBe(1);
    expect(parseHistoryListLimit('25')).toBe(25);
    expect(parseHistoryListLimit('0')).toBeUndefined();
    expect(parseHistoryListLimit('-1')).toBeUndefined();
    expect(parseHistoryListLimit('1.5')).toBeUndefined();
    expect(parseHistoryListLimit('abc')).toBeUndefined();
    expect(parseHistoryListLimit('')).toBeUndefined();
    expect(parseHistoryListLimit(undefined)).toBeUndefined();
  });

  it('returns null for ids without a run view, config, or flow state', async () => {
    mockNothingPersisted();

    await expect(readCliHistoryDetails('deadbe' as RunId)).resolves.toBeNull();
  });

  it('finds a stamped diagnostic-only root in CLI history details', async () => {
    const runId = 'a11ce7a11ce7' as RunId;
    const { defaultSession } = await import('@agent/runtime/SessionHandle');
    const session = defaultSession();
    publishTestRunStart(session, runId);
    session.publishRunEvent(runId, {
      type: 'log',
      level: 'info',
      message: 'Root status only',
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
    });
    await session.settlePublications();
    mockNothingPersisted();
    // The run's own `run.start` plus the diagnostic-only transcript row
    // prove the run exists even though it yields no conversation.

    await expect(readCliHistoryDetails(runId)).resolves.toMatchObject({
      id: runId,
      status: 'unknown',
      conversationPreview: null,
    });
  });

  it('treats full-only conversation data as a found run', async () => {
    mockNothingPersisted();
    mocks.readConversation.mockResolvedValue([
      { kind: 'tool-call', name: 'bash', input: {} },
    ]);

    const details = await readCliHistoryDetails('deadbe' as RunId, {
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

  it('shows the current resumable model without losing the startup model', async () => {
    const toolUseConfig = AgentConfigSchema.parse({
      ...config,
      agent: 'chat',
      model: 'gpt54',
      agentCategory: 'toolUse',
    });
    mocks.readConfig.mockResolvedValue(toolUseConfig);
    mocks.readCliResumedModel.mockResolvedValue('gpt55');

    const details = await readCliHistoryDetails('a1a1a1' as RunId);
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.currentModel).toBe('gpt55');
    expect(text).toContain('Model: gpt55');
    expect(text).toContain('Startup model: gpt54');
  });

  it('shows the team preset in details without hiding the root agent', async () => {
    mocks.readConfig.mockResolvedValue(
      AgentConfigSchema.parse({
        ...config,
        agent: 'engineer',
        model: 'sonnet46T',
        agentCategory: 'toolUse',
        cli: { multiAgentPresetId: ' software-engineer ' },
      }),
    );

    const details = await readCliHistoryDetails('bea111' as RunId);
    const text = formatCliHistoryDetailsText(details!);

    expect(text).toContain('Agent: engineer');
    expect(text).toContain('Team: software-engineer');
    expect(text).not.toContain('Team:  software-engineer ');
  });

  it('surfaces the explicit CLI output file in history details', async () => {
    mocks.readConfig.mockResolvedValue(
      AgentConfigSchema.parse({
        ...config,
        cli: { outputFile: ' /tmp/texra-output/polished.tex ' },
      }),
    );

    const details = await readCliHistoryDetails('a1a1a1' as RunId);
    const text = formatCliHistoryDetailsText(details!);

    expect(text).toContain('CLI output: /tmp/texra-output/polished.tex');
    expect(text).not.toContain('CLI output:  /tmp/texra-output/polished.tex ');
  });

  it('surfaces workflow result metadata in history details', async () => {
    const outputSummary = {
      round: 1,
      relativePath: 'r1/paper.tex',
      absolutePath: '/tmp/run/r1/paper.tex',
      location: 'runStorage' as const,
      originalPath: '/tmp/paper.tex',
      added: 8,
      removed: 0,
    };
    const compileFailure = {
      round: 1,
      displayName: 'paper.tex',
      outputPath: 'r1/paper.tex',
      logPath: 'compile/r1_paper.tex.log',
      logAbsolutePath: '/tmp/run/compile/r1_paper.tex.log',
    };
    const workflowOutput = {
      category: 'workflow',
      outputs: [outputSummary],
      compileFailures: [compileFailure],
      diffs: [],
    };
    mocks.readResultMeta.mockResolvedValue({
      producer: 'cliWorkflow',
      copiedOutput: '/tmp/annotated.tex',
      output: workflowOutput,
    });
    // How the run ended is the `run.end` row's; the producer record carries
    // the output the delivery enriched.
    mocks.readRunEnd.mockResolvedValue({
      outcome: 'completed',
      usage: { totalCost: 0.7 },
      output: { category: 'workflow', outputs: [], compileFailures: [] },
    });

    const details = await readCliHistoryDetails('a1a1a1' as RunId);
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.result).toEqual({
      outcome: 'completed',
      usage: { totalCost: 0.7 },
      output: workflowOutput,
    });
    expect(text).not.toContain('"producer"');
    expect(text).not.toContain('"copiedOutput"');
    expect(text).toContain('"category":"workflow"');
    expect(text).toContain('"outcome":"completed"');
    expect(text).toContain('"compileFailures"');
    expect(text).toContain('compile/r1_paper.tex.log');
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

    const details = await readCliHistoryDetails('a1a1a1' as RunId);
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

    const details = await readCliHistoryDetails('a1a1a1' as RunId, {
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

  it('keeps a placeholder for thinking-only assistant turns', async () => {
    mocks.readConversation.mockResolvedValue([
      { kind: 'assistant-text', text: 'Earlier visible answer.' },
      { kind: 'thinking', text: 'hidden newer reasoning' },
    ]);

    const details = await readCliHistoryDetails('a1a1a1' as RunId, {
      includeFullConversation: true,
    });
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.conversationPreview?.messages).toEqual([
      {
        index: 2,
        role: 'assistant',
        content: '[provider reasoning hidden]',
        truncated: false,
      },
    ]);
    expect(details?.conversation?.messages).toEqual([
      {
        index: 1,
        role: 'assistant',
        content: 'Earlier visible answer.',
        truncated: false,
      },
      {
        index: 2,
        role: 'assistant',
        content: '[provider reasoning hidden]',
        truncated: false,
      },
    ]);
    expect(text).toContain('[assistant #2]\n[provider reasoning hidden]');
    expect(text).not.toContain('hidden newer reasoning');
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

    const details = await readCliHistoryDetails('a1a1a1' as RunId, {
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

    const details = await readCliHistoryDetails('de1e6a' as RunId);

    expect(details?.id).toBe('de1e6a');
    expect(formatCliHistoryDetailsText(details!)).toContain('Parent: f00707');
  });

  it('uses the stored report instead of duplicating conversation preview text', async () => {
    mocks.readReport.mockResolvedValue('Structured report.');
    mocks.readConversation.mockResolvedValue([
      { kind: 'assistant-text', text: 'Final proof analysis.' },
    ]);

    const details = await readCliHistoryDetails('a1a1a1' as RunId);
    const text = formatCliHistoryDetailsText(details!);

    expect(text).toContain('Report:\nStructured report.');
    expect(text).not.toContain('Conversation (');
  });

  it('surfaces persisted workspace files without parsing provider messages', async () => {
    const workspace = await useTempWorkspace();
    await writeFile(path.join(workspace, 'durable.md'), '# durable');
    mocks.readWorkspaceFiles.mockResolvedValue(['durable.md']);
    mockToolCallConversation({
      name: 'write_file',
      args: JSON.stringify({ path: 'legacy.md' }),
    });

    const details = await readCliHistoryDetails('a1a1a1' as RunId);

    expect(details?.files).toEqual([
      { path: 'workspace/durable.md', size: 9, isDirectory: false },
    ]);
  });

  it('preserves persisted paths inside a top-level workspace directory', async () => {
    const workspace = await useTempWorkspace();
    await mkdir(path.join(workspace, 'workspace'));
    await writeFile(path.join(workspace, 'review.md'), 'wrong');
    await writeFile(path.join(workspace, 'workspace', 'review.md'), 'nested');
    mocks.readWorkspaceFiles.mockResolvedValue(['workspace/review.md']);

    const details = await readCliHistoryDetails('a1a1a1' as RunId);

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
    mockToolUseWorkspace(workspace);
    mocks.readWorkspaceFiles.mockResolvedValue([
      '../outside.md',
      outsidePath,
      'missing.md',
    ]);

    const details = await readCliHistoryDetails('a1a1a1' as RunId);

    expect(details?.files).toEqual([]);
  });

  effectIt.live(
    'deletes indexed executions and reports a later missing lookup',
    () =>
      Effect.acquireUseRelease(
        Effect.sync(createTestSession),
        (session) =>
          Effect.gen(function* () {
            const id = 'aabbcc' as RunId;
            publishTestRunStart(session, id);
            yield* Effect.promise(() => session.settlePublications());
            expect(yield* deleteCliHistory(session, { all: true })).toEqual({
              deleted: 'all',
              count: 1,
              active: [],
              failed: [],
            });
            expect(yield* deleteCliHistory(session, { id })).toEqual({
              deleted: 'one',
              id,
              found: false,
              status: 'not-found',
            });
            expect(mocks.listRuns).not.toHaveBeenCalled();
          }),
        (session) => Effect.sync(() => session.dispose()),
      ),
  );

  it('validates run id shape before command handlers use storage', () => {
    expect(parseCliHistoryId('abc123')).toBe('abc123');
    expect(parseCliHistoryId('../abc123')).toBeUndefined();
  });

  describe('history export (--export / --assets-dir)', () => {
    it('builds export input from the stored config, conversation, and run facts', async () => {
      const runId = 'a1a1a1' as RunId;
      mocks.readConversation.mockResolvedValue([
        {
          kind: 'user-message',
          parts: [{ type: 'text', text: 'Polish the lemma.' }],
        },
        { kind: 'assistant-text', text: 'Done.' },
      ]);
      const session = await publishRunFacts(runId, {
        description: 'Polish pass',
      });
      // The export stamps the run's own launch time, which the publisher
      // stamped on `run.start`.
      const launchedAt = (
        await Effect.runPromise(session.readView([]))
      ).runs.get(runId)?.launchedAt;

      const result = await readCliHistoryExportInput(runId);

      expect(result).toEqual({
        status: 'ok',
        exportInput: {
          timestamp: new Date(launchedAt!).toISOString(),
          description: 'Polish pass',
          config: {
            agent: 'correct',
            model: 'deepseekT',
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
    });

    it('reports "not_found" only when there is no trace of the run at all', async () => {
      mockNothingPersisted();

      await expect(
        readCliHistoryExportInput('facade' as RunId),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('reports "incomplete" (not "not_found") when config exists but conversation does not', async () => {
      // history show would still display this run (it has a config) —
      // export just has nothing to render, which is a different failure than
      // the id not resolving to anything at all. This is the beforeEach
      // baseline: stored config, no conversation, no meta.
      await expect(
        readCliHistoryExportInput('a1a1a1' as RunId),
      ).resolves.toEqual({ status: 'incomplete' });
    });

    it('reports "incomplete" (not "not_found") when conversation exists but config does not', async () => {
      mocks.readConfig.mockResolvedValue(null);
      mocks.readConversation.mockResolvedValue([
        { kind: 'assistant-text', text: 'hi' },
      ]);

      await expect(
        readCliHistoryExportInput('a1a1a1' as RunId),
      ).resolves.toEqual({ status: 'incomplete' });
    });

    it('reports "not_found" (not "incomplete") when the stored conversation is an empty array', async () => {
      // A stored-but-empty conversation array is truthy (`![]` is `false`),
      // so a naive `!conversation` check would treat it as "present" and
      // report 'incomplete' here — while `history show` builds no preview
      // from an empty array and, with config/meta also absent, reports the
      // same id as not found. The two commands must agree.
      mockNothingPersisted();
      mocks.readConversation.mockResolvedValue([]);

      await expect(
        readCliHistoryExportInput('facade' as RunId),
      ).resolves.toEqual({ status: 'not_found' });
      await expect(
        readCliHistoryDetails('facade' as RunId),
      ).resolves.toBeNull();
    });

    it('stages the bundled trace-viewer page into the destination directory', async () => {
      const resourcesPath = await makeTempDir(
        'texra-history-export-src-',
        tempDirs,
      );
      await writeViewerBundle(resourcesPath);
      const destDir = await makeAssetsDestDir('texra-history-export-dest-');

      const result = await stageCliHistoryTraceViewerAssets({
        resourcesPath,
        destDir,
      });

      expect(result).toBe('staged');
      expect(await readFile(path.join(destDir, 'index.html'), 'utf8')).toBe(
        '<html></html>',
      );
    });

    it('reports "missing" instead of throwing when the bundled trace-viewer assets are absent', async () => {
      const resourcesPath = await makeTempDir(
        'texra-history-export-empty-',
        tempDirs,
      );

      const result = await stageCliHistoryTraceViewerAssets({
        resourcesPath,
        destDir: await makeAssetsDestDir('texra-history-export-dest-'),
      });

      expect(result).toBe('missing');
    });

    it('reads the bundled trace-viewer default template', async () => {
      const resourcesPath = await makeTempDir(
        'texra-history-standalone-',
        tempDirs,
      );
      const traceViewerDir = path.join(resourcesPath, 'traceViewer');
      await mkdir(traceViewerDir, { recursive: true });
      await writeFile(
        path.join(traceViewerDir, 'index.html'),
        '<html>standalone</html>',
      );

      await expect(
        readCliHistoryStandaloneTemplate(resourcesPath),
      ).resolves.toBe('<html>standalone</html>');
    });

    it('returns null instead of throwing when the default template is absent', async () => {
      const resourcesPath = await makeTempDir(
        'texra-history-standalone-empty-',
        tempDirs,
      );

      await expect(
        readCliHistoryStandaloneTemplate(resourcesPath),
      ).resolves.toBeNull();
    });

    describe('runHistoryExport --assets-dir', () => {
      // Capture every byte written so we can assert on exit code + wording
      // without the real bytes leaking to the test runner's own stdout/stderr.
      let stdout = '';
      let stderr = '';
      let stdoutSpy: ReturnType<typeof vi.spyOn>;
      let stderrSpy: ReturnType<typeof vi.spyOn>;

      function makeTrace(runId: string): TraceDocument {
        return {
          runId,
          config,
          meta: null,
          entries: [],
          snapshot: { todos: [], plan: null, usage: null },
          terminalStatus: null,
        } as unknown as TraceDocument;
      }

      const trace = makeTrace('a1a1a1');

      function makeContext(resourcesPath: string): CliContext {
        return createTestCliContext({
          cwd: '/workspace',
          resourcesPath,
        });
      }

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

      /** Temp resources dir holding the bundled trace viewer. */
      async function makeStagedResources(prefix: string): Promise<string> {
        const resourcesPath = await makeTempDir(prefix, tempDirs);
        await writeViewerBundle(resourcesPath);
        return resourcesPath;
      }

      it('reports missing replayable roots without an empty sidecar list', async () => {
        mocks.assembleTrace.mockReturnValue(
          Effect.succeed({ status: 'streamLogs_missing' }),
        );

        const exitCode = await runHistoryExport(
          makeContext('/resources'),
          'a1a1a1' as RunId,
          'html',
          {},
        );

        expect(exitCode).toBe(CliExitCode.Usage);
        expect(stdout).toBe('');
        expect(stderr).toContain('no replayable run-root transcript');
        expect(stderr).not.toContain('sidecars (');
      });

      it('returns a non-zero exit code (but still writes the trace JSON) when the bundled assets are missing', async () => {
        const resourcesPath = await makeTempDir(
          'texra-history-export-missing-src-',
          tempDirs,
        );
        const destDir = await makeAssetsDestDir(
          'texra-history-export-missing-dest-',
        );

        const exitCode = await runHistoryExport(
          makeContext(resourcesPath),
          'a1a1a1' as RunId,
          'html',
          { assetsDir: destDir },
        );

        expect(exitCode).toBe(CliExitCode.Usage);
        expect(stdout).toBe(JSON.stringify(trace));
        expect(stderr).toContain('were not found in this CLI install');
      });

      it('returns success and writes a concrete (non-placeholder) instruction when assets stage correctly', async () => {
        const resourcesPath = await makeStagedResources(
          'texra-history-export-staged-src-',
        );
        const destDir = await makeAssetsDestDir(
          'texra-history-export-staged-dest-',
        );

        const exitCode = await runHistoryExport(
          makeContext(resourcesPath),
          'a1a1a1' as RunId,
          'html',
          { assetsDir: destDir },
        );

        expect(exitCode).toBe(CliExitCode.Success);
        expect(stdout).toBe(JSON.stringify(trace));
        // The instruction names concrete paths; literal placeholder tokens
        // would read as an unresolved template.
        expect(stderr).not.toContain('<redirected-path>');
        expect(stderr).not.toContain('<relative-path-to-the-redirected-file>');
        expect(stderr).toContain(
          `Wrote trace JSON for a1a1a1 to stdout. Save the output to ` +
            `${path.join(destDir, 'a1a1a1.json')}, then open ` +
            `${destDir}/index.html?trace=a1a1a1.json.`,
        );
      });

      it('uses run-specific trace filenames for repeat exports into the same assets directory', async () => {
        const resourcesPath = await makeStagedResources(
          'texra-history-export-repeat-src-',
        );
        const destDir = await makeAssetsDestDir(
          'texra-history-export-repeat-dest-',
        );
        const firstTrace = makeTrace('abc123');
        const secondTrace = makeTrace('def456');
        mocks.assembleTrace
          .mockReturnValueOnce(
            Effect.succeed({ status: 'ok', trace: firstTrace }),
          )
          .mockReturnValueOnce(
            Effect.succeed({ status: 'ok', trace: secondTrace }),
          );

        const firstExit = await runHistoryExport(
          makeContext(resourcesPath),
          'abc123' as RunId,
          'html',
          { assetsDir: destDir },
        );
        const secondExit = await runHistoryExport(
          makeContext(resourcesPath),
          'def456' as RunId,
          'html',
          { assetsDir: destDir },
        );

        expect(firstExit).toBe(CliExitCode.Success);
        expect(secondExit).toBe(CliExitCode.Success);
        expect(stdout).toBe(
          JSON.stringify(firstTrace) + JSON.stringify(secondTrace),
        );
        expect(stderr).toContain(
          `${path.join(destDir, 'abc123.json')}, then open ` +
            `${destDir}/index.html?trace=abc123.json.`,
        );
        expect(stderr).toContain(
          `${path.join(destDir, 'def456.json')}, then open ` +
            `${destDir}/index.html?trace=def456.json.`,
        );
        expect(stderr).not.toContain('trace=trace.json');
      });
    });
  });
});
