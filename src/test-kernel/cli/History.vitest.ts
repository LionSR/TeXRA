// Test composition imports
import '@test/support/defaultSessionTestSetup';

/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakePlatform } from '@test/support/FakePlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import { createToolUseResumeData } from '@test/support/toolUseResumeTestUtils';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { KVStore } from '@common/storage/KVStore';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { GoalStore } from '@tools/goal';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readConversation: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  readMeta: vi.fn(),
  readResultMeta: vi.fn(),
  readReport: vi.fn(),
  exists: vi.fn(),
  listExecutions: vi.fn(),
  deleteExecution: vi.fn(),
  deleteAllExecutions: vi.fn(),
  readCliToolUseResumeData: vi.fn(),
  readCliResumeDataForListing: vi.fn(),
  assembleTrace: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  const { createFakeKv } = await import('@test/support/FakeExecutionKVStore');
  return {
    ...actual,
    getExecutionStore: vi.fn((executionId: ExecutionId) =>
      createFakeKv(executionId, {
        readConfig: mocks.readConfig,
        readWorkspaceFiles: mocks.readWorkspaceFiles,
        readMeta: mocks.readMeta,
        readMetaStrict: mocks.readMeta,
        readResultMeta: mocks.readResultMeta,
        readReport: mocks.readReport,
        exists: mocks.exists,
      }),
    ),
    listExecutions: mocks.listExecutions,
    deleteExecution: mocks.deleteExecution,
    deleteAllExecutions: mocks.deleteAllExecutions,
  };
});

vi.mock('@utils/files/taskRunStorage', () => ({
  findExistingRunStoragePath: vi.fn(async () => undefined),
}));

vi.mock('@cli/runtime/toolUseResumeData', () => ({
  readCliToolUseResumeData: mocks.readCliToolUseResumeData,
  readCliResumeDataForListing: mocks.readCliResumeDataForListing,
}));

vi.mock('@transcript', async () => {
  const actual =
    await vi.importActual<typeof import('@transcript')>('@transcript');
  return {
    ...actual,
    assembleTrace: mocks.assembleTrace,
    readCompletedRunConversation: vi.fn(async (...args: unknown[]) => {
      const conversation = await mocks.readConversation();
      return conversation === null
        ? actual.readCompletedRunConversation(
            ...(args as Parameters<typeof actual.readCompletedRunConversation>),
          )
        : { conversation, source: 'streamLog' };
    }),
  };
});

// `runHistoryExport` calls this unconditionally; the real implementation
// bootstraps platform agent directories keyed by `resourcesPath`, which is
// unrelated to (and heavier than) what these tests exercise.
vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: vi.fn(),
}));

// Imported after vi.mock so the mocked dependencies are in place.
import { getExecutionStore } from '@agent/storage';
import { parseHistoryListLimit, runHistoryExport } from '@cli/commands/history';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import {
  StreamLogStore,
  StreamSnapshotStore,
  STREAM_LOGS_DIR,
  type TraceDocument,
} from '@transcript';
import {
  cleanupExecutionAdjacentStreamState,
  resolveAdjacentStreamCleanup,
} from '@transcript/adjacentStreamCleanup';
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
  preflightCliHistoryDeleteAll,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  readCliHistoryStandaloneTemplate,
  stageCliHistoryTraceViewerAssets,
} from '@cli/runtime/history';
import {
  appendTranscriptEntry,
  snapshotFacts,
} from '@test/support/storeTestDrivers';

const config = AgentConfigSchema.parse({
  agent: 'correct',
  model: 'deepseekT',
  instruction: 'Polish the introduction.',
  agentCategory: 'workflow',
  inputFiles: ['chapters/intro.tex'],
  outputFiles: ['chapters/intro.tex'],
});

const tempDirs: string[] = [];

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

// Provider-shaped assistant turn carrying tool calls. `args` is passed through
// verbatim so callers can cover both JSON-string and object argument encodings.
function mockToolCallConversation(
  ...calls: ReadonlyArray<{ name: string; args: unknown }>
): void {
  mocks.readConversation.mockResolvedValue([
    {
      role: 'assistant',
      tool_calls: calls.map(({ name, args }) => ({
        type: 'function',
        function: { name, arguments: args },
      })),
    },
  ]);
}

// No persisted config, meta, conversation, or flow state: the execution id
// resolves to nothing unless the test re-mocks one of these afterwards.
function mockNothingPersisted(): void {
  mocks.readConfig.mockResolvedValue(null);
  mocks.readConversation.mockResolvedValue(null);
  mocks.readMeta.mockResolvedValue(null);
  mocks.exists.mockResolvedValue(false);
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
    id: id as ExecutionId,
    timestamp: '2026-05-18T08:00:00.000Z',
    record: config,
    outcome: 'completed',
    ...overrides,
  };
}

// Two orchestrator snapshot rows pointing at `executionId` — session
// bookkeeping only, never transcript evidence (Axis T).
async function seedSidecarOnlySnapshots(
  executionId: ExecutionId,
): Promise<void> {
  const snapshots = new StreamSnapshotStore();
  for (const tag of ['old', 'new']) {
    snapshotFacts(snapshots).setRunConfig(
      `orchestrator@${tag}#${executionId}` as StreamTabId,
      config,
      executionId,
    );
  }
  await snapshots.flush();
}

function mockBulkDelete(deleted: string[]): void {
  mocks.deleteAllExecutions.mockResolvedValue({
    deleted,
    notFound: [],
    active: [],
    failed: [],
  });
}

// An interrupted tool-use run whose resume data carries `agentConfig`, so the
// history list labels it as resumable.
function mockResumableToolUseListing(agentConfig: unknown): void {
  mocks.readCliResumeDataForListing.mockResolvedValue({
    type: 'toolUse',
    agentConfig,
  });
}

// A fresh temp directory to point --assets-dir at.
async function makeAssetsDestDir(prefix: string): Promise<string> {
  const cwd = await makeTempDir(prefix, tempDirs);
  return path.join(cwd, 'shared-assets');
}

// The minimal bundled shared trace-viewer bundle: just an index.html.
async function writeSharedViewerBundle(sharedDir: string): Promise<void> {
  await mkdir(sharedDir, { recursive: true });
  await writeFile(path.join(sharedDir, 'index.html'), '<html></html>');
}

describe('CLI history runtime', () => {
  setupPlatform(async () => {
    const historyStoragePath = await makeTempDir(
      'texra-history-storage-',
      tempDirs,
    );
    return createFakePlatform(
      {
        storagePath: historyStoragePath,
        globalStoragePath: historyStoragePath,
      },
      { fs: nodeFilesystem },
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
    mocks.readMeta.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readReport.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);
    mocks.readCliToolUseResumeData.mockResolvedValue(null);
    mocks.readCliResumeDataForListing.mockResolvedValue(null);
  });

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('formats history list rows with the stable tab-separated text shape', async () => {
    mocks.listExecutions.mockResolvedValue([runListEntry('a1')]);

    const entries = await listCliHistoryEntries();

    expect(formatCliHistoryText(entries)).toBe(
      'a1\t2026-05-18T08:00:00.000Z\tcorrect\tcompleted\tintro.tex',
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
    expect(mocks.readCliResumeDataForListing).toHaveBeenCalledTimes(1);
  });

  it('projects NDJSON status onto the frozen pre-consolidation vocabulary', async () => {
    // Byte parity for the public stream (proposal gate G): terminal outcomes
    // emit as ExecutionStatus ('interrupted'/'error'/'completed');
    // 'resumable'/'unknown' pass through. Internal entries keep RunOutcome.
    mocks.listExecutions.mockResolvedValue(
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
        id: id as ExecutionId,
        timestamp: '2026-05-18T08:00:00.000Z',
        record: config,
        ...(outcome ? { outcome } : {}),
      })),
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
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:00:00.000Z',
      identity: { kind: 'agent', agent: 'correct' },
      outcome: 'cancelled',
    });

    const details = await readCliHistoryDetails('c1' as ExecutionId);
    expect(details?.status).toBe('cancelled');
    expect(cliHistoryDetailNdjsonRecord(details!)).toMatchObject({
      kind: 'history-detail',
      detail: { id: 'c1', status: 'interrupted' },
    });
  });

  it('hides internal process-bookkeeping and configless entries from the history list', async () => {
    const processConfig = toolUseAgentConfig({ agent: 'bash' });
    mocks.listExecutions.mockResolvedValue([
      runListEntry('visible'),
      {
        kind: 'run',
        identity: { kind: 'process', tool: 'bash' },
        id: 'bash-process' as ExecutionId,
        timestamp: '2026-05-18T08:01:00.000Z',
        record: processConfig,
        outcome: 'completed',
      },
      {
        kind: 'incomplete',
        id: 'configless' as ExecutionId,
        timestamp: '2026-05-18T08:02:00.000Z',
        outcome: 'completed',
      },
    ]);

    const entries = await listCliHistoryEntries();

    expect(entries.map((entry) => entry.id)).toEqual(['visible']);
  });

  it('hides agent-spawned child runs from the history list', async () => {
    mocks.listExecutions.mockResolvedValue([
      runListEntry('root'),
      runListEntry('delegated-child', {
        timestamp: '2026-05-18T08:01:00.000Z',
        parentExecutionId: 'root' as ExecutionId,
      }),
    ]);

    const entries = await listCliHistoryEntries();

    expect(entries.map((entry) => entry.id)).toEqual(['root']);
  });

  it('labels multi-agent team runs by preset in history lists', async () => {
    const teamConfig = toolUseAgentConfig({
      agent: 'engineer',
      cliMultiAgentPresetId: ' software-engineer ',
    });
    mocks.listExecutions.mockResolvedValue([
      runListEntry('team1', {
        identity: { kind: 'agent', agent: 'engineer' },
        timestamp: '2026-05-18T10:00:00.000Z',
        record: teamConfig,
        outcome: 'cancelled',
      }),
    ]);
    mockResumableToolUseListing(teamConfig);

    const entries = await listCliHistoryEntries();

    expect(entries[0]?.agent).toBe('engineer');
    expect(entries[0]?.teamPresetId).toBe('software-engineer');
    expect(formatCliHistoryText(entries)).toBe(
      'team1\t2026-05-18T10:00:00.000Z\tteam:software-engineer\tresumable\t-',
    );
  });

  it('uses the history description for no-input chat rows', async () => {
    const chatConfig = toolUseAgentConfig({ agent: 'assistant' });
    mocks.listExecutions.mockResolvedValue([
      runListEntry('chat1', {
        identity: { kind: 'agent', agent: 'assistant' },
        timestamp: '2026-05-18T11:00:00.000Z',
        record: chatConfig,
        outcome: 'cancelled',
        description: 'Sketch a proof outline',
      }),
    ]);
    mockResumableToolUseListing(chatConfig);

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

  it('explains missing history ids as workspace-scoped', () => {
    expect(formatCliHistoryNotFoundText('a9ce2eb983bc' as ExecutionId)).toBe(
      [
        'Execution not found: a9ce2eb983bc',
        'History is scoped by --cwd; use the workspace from the original run or run `texra history list --cwd <workspace>`.',
      ].join('\n'),
    );

    expect(
      formatCliHistoryNotFoundText(
        'a9ce2eb983bc' as ExecutionId,
        '/tmp/texra-workflow-correct-yM0MOz',
      ),
    ).toBe(
      [
        'Execution not found in workspace /tmp/texra-workflow-correct-yM0MOz: a9ce2eb983bc',
        'History is scoped by --cwd; use the workspace from the original run or run `texra history list --cwd <workspace>`.',
      ].join('\n'),
    );
  });

  it('returns null for ids without persisted metadata, config, or flow state', async () => {
    mockNothingPersisted();

    await expect(
      readCliHistoryDetails('dead' as ExecutionId),
    ).resolves.toBeNull();
  });

  it('treats sidecar-only associations as not found in history details', async () => {
    // The sidecar FK maps a stream to an execution for session bookkeeping;
    // since Axis T it is NOT existence evidence for an execution whose
    // metadata carries no stamped stream and whose transcript is empty.
    const executionId = 'a11ce5a11ce5' as ExecutionId;
    await seedSidecarOnlySnapshots(executionId);
    mockNothingPersisted();

    await expect(readCliHistoryDetails(executionId)).resolves.toBeNull();
  });

  it('finds a stamped diagnostic-only root in CLI history details', async () => {
    const executionId = 'a11ce7a11ce7' as ExecutionId;
    const root = `orchestrator@model#${executionId}` as StreamTabId;
    const logs = await StreamLogStore.open();
    appendTranscriptEntry(logs, root, {
      id: 'diagnostic-only-root',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1000,
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      text: 'Root status only',
    });
    await logs.flush();
    mockNothingPersisted();
    // The streamId stamped on execution metadata at registration is the one
    // execution→stream mapping; the diagnostic-only transcript row proves
    // the run exists even though it yields no conversation.
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:00:00.000Z',
      streamId: root,
    });

    await expect(readCliHistoryDetails(executionId)).resolves.toMatchObject({
      id: executionId,
      status: 'unknown',
      conversationPreview: null,
    });
  });

  it('treats full-only conversation data as a found execution', async () => {
    mockNothingPersisted();
    mocks.readConversation.mockResolvedValue([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'bash', arguments: '{}' },
          },
        ],
      },
    ]);

    const details = await readCliHistoryDetails('dead' as ExecutionId, {
      includeFullConversation: true,
    });

    expect(details).toMatchObject({
      id: 'dead',
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

  it('loads the stored config used by resume', async () => {
    await expect(
      getExecutionStore('a1' as ExecutionId).readConfig(),
    ).resolves.toEqual(config);
  });

  it('shows the current resumable model without losing the startup model', async () => {
    const toolUseConfig = AgentConfigSchema.parse({
      ...config,
      agent: 'chat',
      model: 'gpt54',
      agentCategory: 'toolUse',
    });
    mocks.readConfig.mockResolvedValue(toolUseConfig);
    mocks.readCliResumeDataForListing.mockResolvedValue(
      createToolUseResumeData({
        agentConfig: { ...toolUseConfig, model: 'gpt55' },
      }),
    );

    const details = await readCliHistoryDetails('a1' as ExecutionId);
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
        cliMultiAgentPresetId: ' software-engineer ',
      }),
    );

    const details = await readCliHistoryDetails('team1' as ExecutionId);
    const text = formatCliHistoryDetailsText(details!);

    expect(text).toContain('Agent: engineer');
    expect(text).toContain('Team: software-engineer');
    expect(text).not.toContain('Team:  software-engineer ');
  });

  it('surfaces the explicit CLI output file in history details', async () => {
    mocks.readConfig.mockResolvedValue(
      AgentConfigSchema.parse({
        ...config,
        cliOutputFile: ' /tmp/texra-output/polished.tex ',
      }),
    );

    const details = await readCliHistoryDetails('a1' as ExecutionId);
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
    mocks.readResultMeta.mockResolvedValue({
      producer: 'cliWorkflow',
      copiedOutput: '/tmp/annotated.tex',
      result: {
        category: 'workflow',
        outcome: 'completed',
        outputs: [outputSummary],
        compileFailures: [compileFailure],
        diffs: [],
        cost: 0.7,
      },
    });

    const details = await readCliHistoryDetails('a1' as ExecutionId);
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.result).toEqual({
      category: 'workflow',
      outcome: 'completed',
      outputs: [outputSummary],
      compileFailures: [compileFailure],
      diffs: [],
      cost: 0.7,
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
      { role: 'user', content: 'Review the proof.' },
      { role: 'assistant', content: '' },
      { role: 'tool', content: 'problem.tex contents' },
      { role: 'assistant', content: 'Final proof analysis.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
    ]);

    const details = await readCliHistoryDetails('a1' as ExecutionId);
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

  it('omits provider thinking blocks from history previews', async () => {
    mocks.readConversation.mockResolvedValue([
      { role: 'user', content: 'Polish the lemma.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'hidden chain of thought',
            signature: 'secret-signature',
          },
          { type: 'text', text: 'Final polished lemma.' },
        ],
      },
    ]);

    const details = await readCliHistoryDetails('a1' as ExecutionId, {
      includeFullConversation: true,
    });
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.conversationPreview?.messages).toEqual([
      {
        index: 2,
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
        content: 'Final polished lemma.',
        truncated: false,
      },
    ]);
    expect(text).toContain('[assistant #2]\nFinal polished lemma.');
    expect(text).not.toContain('hidden chain of thought');
    expect(text).not.toContain('secret-signature');
  });

  it('keeps a placeholder for thinking-only assistant turns', async () => {
    mocks.readConversation.mockResolvedValue([
      { role: 'assistant', content: 'Earlier visible answer.' },
      {
        role: 'assistant',
        content: [
          {
            type: 'redacted_thinking',
            thinking: 'hidden newer reasoning',
            signature: 'new-secret-signature',
          },
        ],
      },
    ]);

    const details = await readCliHistoryDetails('a1' as ExecutionId, {
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
    expect(text).not.toContain('new-secret-signature');
  });

  it('can show the full stored conversation for post-run inspection', async () => {
    const longToolOutput = `${'tool-output-line\n'.repeat(320)}done`;
    mocks.readConversation.mockResolvedValue([
      { role: 'user', content: 'Review the proof.' },
      { role: 'assistant', content: '' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', content: 'problem.tex contents' },
      { role: 'tool', content: longToolOutput },
      { role: 'assistant', content: 'Final proof analysis.' },
    ]);

    const details = await readCliHistoryDetails('a1' as ExecutionId, {
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
          role: 'tool',
          content: 'problem.tex contents',
          truncated: false,
        },
        {
          index: 5,
          role: 'tool',
          content: longToolOutput,
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
    expect(text).toContain('[tool #4]\nproblem.tex contents');
    expect(text).toContain(`[tool #5]\n${longToolOutput}`);
    expect(text).not.toContain('...[truncated]');
    expect(text).toContain('[assistant #6]\nFinal proof analysis.');
  });

  it('can show Gemini parts-based conversations', async () => {
    mocks.readConversation.mockResolvedValue([
      {
        role: 'user',
        parts: [{ text: 'Solve the finite Pell check.' }],
      },
      {
        role: 'model',
        parts: [
          { text: 'I will inspect the workspace first.' },
          {
            functionCall: {
              name: 'ls',
              args: { path: '.' },
              id: 'tool-1',
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'tool-1',
              name: 'ls',
              response: { result: 'file problem.tex' },
            },
          },
        ],
      },
      {
        role: 'model',
        parts: [{ text: 'Final answer: (9, 4) and (-9, 4).' }],
      },
    ]);

    const details = await readCliHistoryDetails('a1' as ExecutionId, {
      includeFullConversation: true,
    });
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.conversationPreview?.messages).toEqual([
      {
        index: 4,
        role: 'model',
        content: 'Final answer: (9, 4) and (-9, 4).',
        truncated: false,
      },
    ]);
    expect(details?.conversation).toEqual({
      messageCount: 4,
      messages: [
        {
          index: 1,
          role: 'user',
          content: 'Solve the finite Pell check.',
          truncated: false,
        },
        {
          index: 2,
          role: 'model',
          content: 'I will inspect the workspace first.\n[tool_use: ls]',
          truncated: false,
        },
        {
          index: 3,
          role: 'user',
          content: '[tool_result: file problem.tex]',
          truncated: false,
        },
        {
          index: 4,
          role: 'model',
          content: 'Final answer: (9, 4) and (-9, 4).',
          truncated: false,
        },
      ],
    });
    expect(text).toContain('[model #2]');
    expect(text).toContain('I will inspect the workspace first.');
    expect(text).toContain('[tool_use: ls]');
    expect(text).toContain('[user #3]\n[tool_result: file problem.tex]');
    expect(text).toContain('[model #4]\nFinal answer: (9, 4) and (-9, 4).');
  });

  it('still shows a child run asked for by explicit id', async () => {
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:01:00.000Z',
      parentExecutionId: 'root',
      terminalStatus: 'completed',
    });

    const details = await readCliHistoryDetails(
      'delegated-child' as ExecutionId,
    );

    expect(details?.id).toBe('delegated-child');
    expect(formatCliHistoryDetailsText(details!)).toContain('Parent: root');
  });

  it('uses the stored report instead of duplicating conversation preview text', async () => {
    mocks.readReport.mockResolvedValue('Structured report.');
    mocks.readConversation.mockResolvedValue([
      { role: 'assistant', content: 'Final proof analysis.' },
    ]);

    const details = await readCliHistoryDetails('a1' as ExecutionId);
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

    const details = await readCliHistoryDetails('a1' as ExecutionId);

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

    const details = await readCliHistoryDetails('a1' as ExecutionId);

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

    const details = await readCliHistoryDetails('a1' as ExecutionId);

    expect(details?.files).toEqual([]);
  });

  it('reports not-found deletion through the structured result', async () => {
    mocks.deleteExecution.mockResolvedValue({
      status: 'not-found',
      executionId: 'abc123',
    });

    await expect(
      deleteCliHistory({ id: 'abc123' as ExecutionId }),
    ).resolves.toEqual({
      deleted: 'one',
      id: 'abc123',
      found: false,
      status: 'not-found',
    });
  });

  it('drops the goal owned by a deleted execution', async () => {
    const streamId = 'chat@deepseek#a1' as StreamTabId;
    await GoalStore.start(streamId, 'finish the cleanup');
    mocks.deleteExecution.mockResolvedValue({
      status: 'deleted',
      executionId: 'a1',
    });

    await expect(
      deleteCliHistory({ id: 'a1' as ExecutionId }),
    ).resolves.toEqual({
      deleted: 'one',
      id: 'a1',
      found: true,
      status: 'deleted',
    });

    expect(GoalStore.getForStream(streamId)).toBeNull();
  });

  it('deletes one execution sidecar set despite an unrelated corrupt transcript', async () => {
    const executionId = 'a1' as ExecutionId;
    const streamId = 'chat@deepseek#a1' as StreamTabId;
    const unrelated = 'chat@deepseek#corrupt' as StreamTabId;
    const logs = await StreamLogStore.open();
    appendTranscriptEntry(logs, streamId, {
      id: 'target-entry',
      type: STREAM_LOG_ENTRY_TYPES.LOG,
      level: LOG_LEVELS.INFO,
      timestamp: 1000,
      messageType: MESSAGE_TYPES.PROGRESS_STATUS,
      text: 'Target transcript',
    });
    await logs.flush();
    const persistedLogs = new KVStore(STREAM_LOGS_DIR, { compactJson: true });
    await persistedLogs.write(unrelated, { invalid: 'transcript' });
    const snapshots = new StreamSnapshotStore();
    snapshotFacts(snapshots).setRunConfig(streamId, config, executionId);
    await snapshots.flush();
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:00:00.000Z',
      streamId,
    });

    await cleanupExecutionAdjacentStreamState(
      executionId,
      resolveAdjacentStreamCleanup(undefined),
    );

    await expect(persistedLogs.exists(streamId)).resolves.toBe(false);
    await expect(persistedLogs.exists(unrelated)).resolves.toBe(true);
    await expect(
      new StreamSnapshotStore().readPersistedExecutionId(streamId),
    ).resolves.toBeUndefined();
  });

  it('reports a sidecar cleanup failure before deleting execution storage', async () => {
    const executionId = 'a1' as ExecutionId;
    const streamId = 'chat@deepseek#a1' as StreamTabId;
    mocks.readMeta.mockResolvedValue({
      timestamp: '2026-05-18T08:00:00.000Z',
      streamId,
    });

    await expect(
      cleanupExecutionAdjacentStreamState(executionId, {
        deleteAdjacentStreamState: async () => {
          throw new Error('snapshot permission denied');
        },
      }),
    ).rejects.toThrow(
      "Execution a1's transcript/snapshot sidecars could not be cleaned up: snapshot permission denied",
    );
  });

  it('validates execution id shape before command handlers use storage', () => {
    expect(parseCliHistoryId('abc123')).toBe('abc123');
    expect(parseCliHistoryId('../abc123')).toBeUndefined();
  });

  it('preflight refuses --all without --yes and quotes the count', async () => {
    mocks.listExecutions.mockResolvedValue([{}, {}, {}, {}, {}]);

    await expect(
      preflightCliHistoryDeleteAll({ all: true, yes: false }),
    ).resolves.toEqual({ proceed: false, count: 5 });

    // The runtime listing was the source of truth — assert we asked it.
    expect(mocks.listExecutions).toHaveBeenCalled();
    // Critically, deleteAllExecutions was NOT called by the preflight.
    expect(mocks.deleteAllExecutions).not.toHaveBeenCalled();
  });

  it('preflight clears --all when --yes is set and reports the count', async () => {
    mocks.listExecutions.mockResolvedValue([{}, {}]);

    await expect(
      preflightCliHistoryDeleteAll({ all: true, yes: true }),
    ).resolves.toEqual({ proceed: true, count: 2 });
  });

  it('preflight short-circuits when --all is not set', async () => {
    await expect(
      preflightCliHistoryDeleteAll({ all: false, yes: false }),
    ).resolves.toEqual({ proceed: false, count: 0 });

    // No need to ask storage if we are not in the bulk path.
    expect(mocks.listExecutions).not.toHaveBeenCalled();
  });

  it('surfaces the bulk-delete count in the structured result', async () => {
    mockBulkDelete(['a1', 'b2', 'c3', 'd4']);

    await expect(deleteCliHistory({ all: true })).resolves.toEqual({
      deleted: 'all',
      count: 4,
      active: [],
      failed: [],
    });
  });

  it('uses the authoritative deleted count without re-listing', async () => {
    mockBulkDelete(['a1']);

    await expect(deleteCliHistory({ all: true })).resolves.toEqual({
      deleted: 'all',
      count: 1,
      active: [],
      failed: [],
    });

    // listExecutions must not be called when the count was passed in.
    expect(mocks.listExecutions).not.toHaveBeenCalled();
  });

  it('drops only goals owned by deleted executions in the bulk path', async () => {
    const deletedA = 'chat@deepseek#a1' as StreamTabId;
    const deletedB = 'review@deepseek#b2' as StreamTabId;
    const live = 'chat@deepseek#live' as StreamTabId;
    await GoalStore.start(deletedA, 'delete a');
    await GoalStore.start(deletedB, 'delete b');
    await GoalStore.start(live, 'keep me');
    mockBulkDelete(['a1', 'b2']);

    await deleteCliHistory({ all: true });

    expect(GoalStore.getForStream(deletedA)).toBeNull();
    expect(GoalStore.getForStream(deletedB)).toBeNull();
    expect(GoalStore.getForStream(live)?.objective).toBe('keep me');
  });

  describe('history export (--export / --assets-dir)', () => {
    it('quotes the value in an invalid --export message, including an empty string', () => {
      expect(formatInvalidExportFormatText('csv')).toBe(
        'Invalid export format: "csv" (use html or md)',
      );
      // Must not collapse into "Invalid export format:  (use html or md)"
      // with a confusing double space.
      expect(formatInvalidExportFormatText('')).toBe(
        'Invalid export format: "" (use html or md)',
      );
    });

    it('builds export input from the stored config, conversation, and meta', async () => {
      mocks.readConversation.mockResolvedValue([
        { role: 'user', content: 'Polish the lemma.' },
        { role: 'assistant', content: 'Done.' },
      ]);
      mocks.readMeta.mockResolvedValue({
        timestamp: '2026-05-18T08:00:00.000Z',
        description: 'Polish pass',
      });

      const result = await readCliHistoryExportInput('a1' as ExecutionId);

      expect(result).toEqual({
        status: 'ok',
        exportInput: {
          timestamp: '2026-05-18T08:00:00.000Z',
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
          messages: [
            { role: 'user', content: 'Polish the lemma.' },
            { role: 'assistant', content: 'Done.' },
          ],
        },
      });
    });

    it('reports "not_found" only when there is no trace of the execution at all', async () => {
      mockNothingPersisted();

      await expect(
        readCliHistoryExportInput('missing' as ExecutionId),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('reports sidecar-only associations as not found for markdown export', async () => {
      // Since Axis T the sidecar FK is session bookkeeping, not transcript
      // evidence: without meta, config, a stamped stream, or a conversation,
      // the id resolves to nothing at all.
      const executionId = 'a11ce6a11ce6' as ExecutionId;
      await seedSidecarOnlySnapshots(executionId);
      mockNothingPersisted();

      await expect(readCliHistoryExportInput(executionId)).resolves.toEqual({
        status: 'not_found',
      });
    });

    it('reports "incomplete" (not "not_found") when config exists but conversation does not', async () => {
      // history show would still display this execution (it has a config) —
      // export just has nothing to render, which is a different failure than
      // the id not resolving to anything at all. This is the beforeEach
      // baseline: stored config, no conversation, no meta.
      await expect(
        readCliHistoryExportInput('a1' as ExecutionId),
      ).resolves.toEqual({ status: 'incomplete' });
    });

    it('reports "incomplete" (not "not_found") when conversation exists but config does not', async () => {
      mocks.readConfig.mockResolvedValue(null);
      mocks.readConversation.mockResolvedValue([
        { role: 'user', content: 'hi' },
      ]);

      await expect(
        readCliHistoryExportInput('a1' as ExecutionId),
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
        readCliHistoryExportInput('missing' as ExecutionId),
      ).resolves.toEqual({ status: 'not_found' });
      await expect(
        readCliHistoryDetails('missing' as ExecutionId),
      ).resolves.toBeNull();
    });

    it('still reports "incomplete" when config exists but the stored conversation is only an empty array', async () => {
      mocks.readConversation.mockResolvedValue([]);

      await expect(
        readCliHistoryExportInput('a1' as ExecutionId),
      ).resolves.toEqual({ status: 'incomplete' });
    });

    it('stages the bundled trace-viewer shared bundle into the destination directory', async () => {
      const resourcesPath = await makeTempDir(
        'texra-history-export-src-',
        tempDirs,
      );
      await writeSharedViewerBundle(
        path.join(resourcesPath, 'traceViewerShared'),
      );
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

    it('merges into a pre-existing destination directory instead of nesting under it', async () => {
      // A repeat export pointed at the same --assets-dir must not turn
      // `<dir>/assets/index-xxx.js` into
      // `<dir>/traceViewerShared/assets/index-xxx.js`.
      const resourcesPath = await makeTempDir(
        'texra-history-export-src-',
        tempDirs,
      );
      const sharedDir = path.join(resourcesPath, 'traceViewerShared');
      await writeSharedViewerBundle(sharedDir);
      await mkdir(path.join(sharedDir, 'assets'), { recursive: true });
      await writeFile(path.join(sharedDir, 'assets', 'index.js'), 'js-bytes');

      const destDir = await makeAssetsDestDir('texra-history-export-dest-');
      await mkdir(destDir, { recursive: true });
      await writeFile(
        path.join(destDir, 'trace.json'),
        'pre-existing trace data',
      );

      await stageCliHistoryTraceViewerAssets({ resourcesPath, destDir });
      // Stage again — the common "many exports, one shared dir" case.
      const result = await stageCliHistoryTraceViewerAssets({
        resourcesPath,
        destDir,
      });

      expect(result).toBe('staged');
      expect(await readFile(path.join(destDir, 'index.html'), 'utf8')).toBe(
        '<html></html>',
      );
      expect(
        await readFile(path.join(destDir, 'assets', 'index.js'), 'utf8'),
      ).toBe('js-bytes');
      expect(await readFile(path.join(destDir, 'trace.json'), 'utf8')).toBe(
        'pre-existing trace data',
      );
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

      function makeTrace(executionId: string): TraceDocument {
        return {
          executionId,
          streamId: executionId,
          config,
          meta: null,
          entries: [],
          snapshot: { todos: [], plan: null, usage: null },
          terminalStatus: null,
        } as unknown as TraceDocument;
      }

      const trace = makeTrace('a1');

      function makeContext(resourcesPath: string): CliContext {
        return createTestCliContext({
          cwd: '/workspace',
          resourcesPath,
        });
      }

      beforeEach(() => {
        stdout = '';
        stderr = '';
        mocks.assembleTrace.mockResolvedValue({ status: 'ok', trace });
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

      /** Temp resources dir holding the bundled shared trace-viewer assets. */
      async function makeStagedResources(prefix: string): Promise<string> {
        const resourcesPath = await makeTempDir(prefix, tempDirs);
        await writeSharedViewerBundle(
          path.join(resourcesPath, 'traceViewerShared'),
        );
        return resourcesPath;
      }

      it('reports missing replayable roots without an empty sidecar list', async () => {
        mocks.assembleTrace.mockResolvedValue({ status: 'streamLogs_missing' });

        const exitCode = await runHistoryExport(
          makeContext('/resources'),
          'a1' as ExecutionId,
          'html',
          {},
        );

        expect(exitCode).toBe(CliExitCode.Usage);
        expect(stdout).toBe('');
        expect(stderr).toContain('no replayable execution-root transcript');
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
          'a1' as ExecutionId,
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
          'a1' as ExecutionId,
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
          `Wrote trace JSON for a1 to stdout. Save the output to ` +
            `${path.join(destDir, 'a1.json')}, then open ` +
            `${destDir}/index.html?trace=a1.json.`,
        );
      });

      it('uses execution-specific trace filenames for repeat exports into the same assets directory', async () => {
        const resourcesPath = await makeStagedResources(
          'texra-history-export-repeat-src-',
        );
        const destDir = await makeAssetsDestDir(
          'texra-history-export-repeat-dest-',
        );
        const firstTrace = makeTrace('abc123');
        const secondTrace = makeTrace('def456');
        mocks.assembleTrace
          .mockResolvedValueOnce({ status: 'ok', trace: firstTrace })
          .mockResolvedValueOnce({ status: 'ok', trace: secondTrace });

        const firstExit = await runHistoryExport(
          makeContext(resourcesPath),
          'abc123' as ExecutionId,
          'html',
          { assetsDir: destDir },
        );
        const secondExit = await runHistoryExport(
          makeContext(resourcesPath),
          'def456' as ExecutionId,
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
