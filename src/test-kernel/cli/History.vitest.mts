// Test composition imports
import '@test/support/defaultSessionTestSetup';

/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import type { ExecutionId, StreamTabId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { GoalStore } from '@tools/goal';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readConversation: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  readMeta: vi.fn(),
  readResultMeta: vi.fn(),
  readReport: vi.fn(),
  exists: vi.fn(),
  deriveResumability: vi.fn(),
  listExecutions: vi.fn(),
  deleteExecution: vi.fn(),
  deleteAllExecutions: vi.fn(),
  readCliToolUseResumeData: vi.fn(),
  readCliToolUseResumeDataForListing: vi.fn(),
  assembleTrace: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    getExecutionStore: vi.fn(() => ({
      readConfig: mocks.readConfig,
      readConversation: mocks.readConversation,
      readWorkspaceFiles: mocks.readWorkspaceFiles,
      readMeta: mocks.readMeta,
      readResultMeta: mocks.readResultMeta,
      readReport: mocks.readReport,
      exists: mocks.exists,
    })),
    deriveResumability: mocks.deriveResumability,
    listExecutions: mocks.listExecutions,
    deleteExecution: mocks.deleteExecution,
    deleteAllExecutions: mocks.deleteAllExecutions,
    getExecutionLiveness: vi.fn(async () => ({ live: false })),
    listLiveExecutionIds: vi.fn(async () => []),
  };
});

vi.mock('@utils/files/taskRunStorage', () => ({
  findExistingRunStoragePath: vi.fn(async () => undefined),
}));

vi.mock('@cli/runtime/toolUseResumeData', () => ({
  readCliToolUseResumeData: mocks.readCliToolUseResumeData,
  readCliToolUseResumeDataForListing: mocks.readCliToolUseResumeDataForListing,
}));

vi.mock('@transcript', async () => {
  const actual =
    await vi.importActual<typeof import('@transcript')>('@transcript');
  return {
    ...actual,
    assembleTrace: mocks.assembleTrace,
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
import type { TraceDocument } from '@transcript';
import {
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryDetailsText,
  formatCliHistoryNotFoundText,
  formatCliHistoryText,
  formatInvalidExportFormatText,
  listCliHistoryEntries,
  parseCliHistoryId,
  preflightCliHistoryDeleteAll,
  readCliHistoryConfig,
  readCliHistoryDetails,
  readCliHistoryExportInput,
  readCliHistoryStandaloneTemplate,
  stageCliHistoryTraceViewerAssets,
} from '@cli/runtime/history';

const config = {
  agent: 'correct',
  model: 'deepseekT',
  instruction: 'Polish the introduction.',
  agentCategory: 'workflow',
  inputFiles: ['chapters/intro.tex'],
  outputFiles: ['chapters/intro.tex'],
  contextFiles: [],
  mediaFiles: [],
  editedFile: null,
  editedFiles: [],
  memories: [],
  toolConfig: DEFAULT_TOOL_CONFIG,
} as AgentConfig;

let historyStoragePath: string | undefined;

/** Creates a temp dir for the test body, then removes it (recursively) after. */
async function withTempDir(
  prefix: string,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('CLI history runtime', () => {
  beforeEach(async () => {
    const [{ initPlatform }, { nodeFilesystem }, { createFakePlatform }] =
      await Promise.all([
        import('@platform/platform'),
        import('@platform/defaults/nodeFilesystem'),
        import('@test/support/FakePlatform'),
      ]);
    historyStoragePath = await mkdtemp(
      path.join(tmpdir(), 'texra-history-storage-'),
    );
    initPlatform(
      createFakePlatform(
        {
          storagePath: historyStoragePath,
          globalStoragePath: historyStoragePath,
        },
        { fs: nodeFilesystem },
      ),
    );
    vi.clearAllMocks();
    mocks.readConfig.mockResolvedValue(config);
    mocks.readConversation.mockResolvedValue(null);
    mocks.readWorkspaceFiles.mockResolvedValue([]);
    mocks.readMeta.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readReport.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);
    mocks.deriveResumability.mockResolvedValue({
      resumable: false,
      cause: 'missing-flow',
    });
    mocks.readCliToolUseResumeData.mockResolvedValue(null);
    mocks.readCliToolUseResumeDataForListing.mockResolvedValue(null);
  });

  afterEach(async () => {
    if (!historyStoragePath) return;
    await rm(historyStoragePath, { recursive: true, force: true });
    historyStoragePath = undefined;
  });

  it('formats history list rows with the stable tab-separated text shape', async () => {
    mocks.listExecutions.mockResolvedValue([
      {
        kind: 'agent',
        id: 'a1' as ExecutionId,
        timestamp: '2026-05-18T08:00:00.000Z',
        agentConfig: config,
        terminalStatus: 'completed',
      },
    ]);

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
    expect(mocks.readCliToolUseResumeDataForListing).not.toHaveBeenCalled();
  });

  it('hides internal process-bookkeeping and configless entries from the history list', async () => {
    const processConfig = {
      ...config,
      agent: 'bash',
      agentCategory: 'toolUse',
      inputFiles: [],
      outputFiles: [],
    } as AgentConfig;
    mocks.listExecutions.mockResolvedValue([
      {
        kind: 'agent',
        id: 'visible' as ExecutionId,
        timestamp: '2026-05-18T08:00:00.000Z',
        agentConfig: config,
        terminalStatus: 'completed',
      },
      {
        kind: 'process',
        id: 'bash-process' as ExecutionId,
        timestamp: '2026-05-18T08:01:00.000Z',
        agentConfig: processConfig,
        terminalStatus: 'completed',
      },
      {
        kind: 'incomplete',
        id: 'configless' as ExecutionId,
        timestamp: '2026-05-18T08:02:00.000Z',
        terminalStatus: 'completed',
      },
    ]);

    const entries = await listCliHistoryEntries();

    expect(entries.map((entry) => entry.id)).toEqual(['visible']);
  });

  it('labels multi-agent team runs by preset in history lists', async () => {
    const teamConfig = {
      ...config,
      agent: 'engineer',
      agentCategory: 'toolUse',
      inputFiles: [],
      outputFiles: [],
      cliMultiAgentPresetId: ' software-engineer ',
    } as AgentConfig;
    mocks.listExecutions.mockResolvedValue([
      {
        kind: 'agent',
        id: 'team1' as ExecutionId,
        timestamp: '2026-05-18T10:00:00.000Z',
        agentConfig: teamConfig,
        terminalStatus: 'resumable',
      },
    ]);

    const entries = await listCliHistoryEntries();

    expect(entries[0]?.agent).toBe('engineer');
    expect(entries[0]?.teamPresetId).toBe('software-engineer');
    expect(formatCliHistoryText(entries)).toBe(
      'team1\t2026-05-18T10:00:00.000Z\tteam:software-engineer\tresumable\t-',
    );
  });

  it('uses the history description for no-input chat rows', async () => {
    const chatConfig = {
      ...config,
      agent: 'assistant',
      agentCategory: 'toolUse',
      inputFiles: [],
    } as AgentConfig;
    mocks.listExecutions.mockResolvedValue([
      {
        kind: 'agent',
        id: 'chat1' as ExecutionId,
        timestamp: '2026-05-18T11:00:00.000Z',
        agentConfig: chatConfig,
        terminalStatus: 'resumable',
        description: 'Sketch a proof outline',
      },
    ]);

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
    mocks.readConfig.mockResolvedValue(null);
    mocks.readMeta.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);

    await expect(
      readCliHistoryDetails('dead' as ExecutionId),
    ).resolves.toBeNull();
  });

  it('treats full-only conversation data as a found execution', async () => {
    mocks.readConfig.mockResolvedValue(null);
    mocks.readMeta.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);
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
    await expect(readCliHistoryConfig('a1' as ExecutionId)).resolves.toEqual(
      config,
    );
  });

  it('shows the current resumable model without losing the startup model', async () => {
    const toolUseConfig = {
      ...config,
      agent: 'chat',
      model: 'gpt54',
      agentCategory: 'toolUse',
    } as AgentConfig;
    mocks.readConfig.mockResolvedValue(toolUseConfig);
    mocks.deriveResumability.mockResolvedValue({
      resumable: true,
      cause: 'interrupted-with-flow',
    });
    mocks.readCliToolUseResumeDataForListing.mockResolvedValue({
      streamId: 'chat@gpt54#a1',
      config: toolUseConfig,
      snapshot: { agentConfig: { ...toolUseConfig, model: 'gpt55' } },
    });

    const details = await readCliHistoryDetails('a1' as ExecutionId);
    const text = formatCliHistoryDetailsText(details!);

    expect(details?.currentModel).toBe('gpt55');
    expect(text).toContain('Model: gpt55');
    expect(text).toContain('Startup model: gpt54');
  });

  it('shows the team preset in details without hiding the root agent', async () => {
    mocks.readConfig.mockResolvedValue({
      ...config,
      agent: 'engineer',
      model: 'sonnet46T',
      agentCategory: 'toolUse',
      cliMultiAgentPresetId: ' software-engineer ',
    } as AgentConfig);

    const details = await readCliHistoryDetails('team1' as ExecutionId);
    const text = formatCliHistoryDetailsText(details!);

    expect(text).toContain('Agent: engineer');
    expect(text).toContain('Team: software-engineer');
    expect(text).not.toContain('Team:  software-engineer ');
  });

  it('surfaces the explicit CLI output file in history details', async () => {
    mocks.readConfig.mockResolvedValue({
      ...config,
      cliOutputFile: ' /tmp/texra-output/polished.tex ',
    } as AgentConfig);

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
    expect(formatCliHistoryDetailsText(details!)).toContain(
      [
        'Conversation (5 messages; showing assistant message 4):',
        '',
        '[assistant #4]',
        'Final proof analysis.',
      ].join('\n'),
    );
    expect(formatCliHistoryDetailsText(details!)).not.toContain(
      'problem.tex contents',
    );
    expect(formatCliHistoryDetailsText(details!)).not.toContain(
      '[tool_use: read_file]',
    );
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
    await withTempDir('texra-history-', async (workspace) => {
      await writeFile(path.join(workspace, 'durable.md'), '# durable');
      mocks.readConfig.mockResolvedValue({
        ...config,
        agentCategory: 'toolUse',
        workingDirectory: workspace,
      });
      mocks.readWorkspaceFiles.mockResolvedValue(['durable.md']);
      mocks.readConversation.mockResolvedValue([
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: 'legacy.md' }),
              },
            },
          ],
        },
      ]);

      const details = await readCliHistoryDetails('a1' as ExecutionId);

      expect(details?.files).toEqual([
        { path: 'workspace/durable.md', size: 9, isDirectory: false },
      ]);
    });
  });

  it('preserves persisted paths inside a top-level workspace directory', async () => {
    await withTempDir('texra-history-', async (workspace) => {
      await mkdir(path.join(workspace, 'workspace'));
      await writeFile(path.join(workspace, 'review.md'), 'wrong');
      await writeFile(path.join(workspace, 'workspace', 'review.md'), 'nested');
      mocks.readConfig.mockResolvedValue({
        ...config,
        agentCategory: 'toolUse',
        workingDirectory: workspace,
      });
      mocks.readWorkspaceFiles.mockResolvedValue(['workspace/review.md']);

      const details = await readCliHistoryDetails('a1' as ExecutionId);

      expect(details?.files).toEqual([
        { path: 'workspace/workspace/review.md', size: 6, isDirectory: false },
      ]);
    });
  });

  it('surfaces workspace files written by tool-use calls', async () => {
    await withTempDir('texra-history-', async (workspace) => {
      await writeFile(path.join(workspace, 'review.md'), '# report');
      await writeFile(path.join(workspace, 'draft.tex'), 'old text');
      mocks.readConfig.mockResolvedValue({
        ...config,
        agentCategory: 'toolUse',
        workingDirectory: workspace,
      });
      mocks.readConversation.mockResolvedValue([
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({
                  path: 'review.md',
                  content: '# report',
                }),
              },
            },
            {
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: {
                  path: 'draft.tex',
                  old_str: 'old',
                  new_str: 'new',
                },
              },
            },
          ],
        },
      ]);

      const details = await readCliHistoryDetails('a1' as ExecutionId);

      expect(details?.files).toEqual([
        { path: 'workspace/draft.tex', size: 8, isDirectory: false },
        { path: 'workspace/review.md', size: 8, isDirectory: false },
      ]);
      expect(formatCliHistoryDetailsText(details!)).toContain(
        '8\tworkspace/review.md',
      );
    });
  });

  it('surfaces workspace files from Responses function call records', async () => {
    await withTempDir('texra-history-', async (workspace) => {
      await writeFile(path.join(workspace, 'response.md'), 'response');
      mocks.readConfig.mockResolvedValue({
        ...config,
        agentCategory: 'toolUse',
        workingDirectory: workspace,
      });
      mocks.readConversation.mockResolvedValue([
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'write_file',
          arguments: JSON.stringify({ path: 'response.md' }),
        },
      ]);

      const details = await readCliHistoryDetails('a1' as ExecutionId);

      expect(details?.files).toEqual([
        { path: 'workspace/response.md', size: 8, isDirectory: false },
      ]);
    });
  });

  it('surfaces workspace files from Google functionCall parts', async () => {
    await withTempDir('texra-history-', async (workspace) => {
      await mkdir(path.join(workspace, 'subdir'));
      await writeFile(path.join(workspace, 'subdir', 'gemini.md'), 'gemini');
      mocks.readConfig.mockResolvedValue({
        ...config,
        agentCategory: 'toolUse',
        workingDirectory: workspace,
      });
      mocks.readConversation.mockResolvedValue([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'edit_file',
                args: { path: 'subdir/gemini.md' },
              },
            },
          ],
        },
      ]);

      const details = await readCliHistoryDetails('a1' as ExecutionId);

      expect(details?.files).toEqual([
        { path: 'workspace/subdir/gemini.md', size: 6, isDirectory: false },
      ]);
    });
  });

  it('does not surface missing files or tool paths outside the workspace', async () => {
    await withTempDir('texra-history-root-', async (root) => {
      const workspace = path.join(root, 'workspace');
      const outsidePath = path.join(root, 'outside.md');
      await mkdir(workspace);
      await writeFile(outsidePath, 'outside');
      mocks.readConfig.mockResolvedValue({
        ...config,
        agentCategory: 'toolUse',
        workingDirectory: workspace,
      });
      mocks.readConversation.mockResolvedValue([
        {
          role: 'assistant',
          tool_calls: [
            {
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: '../outside.md' }),
              },
            },
            {
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({ path: outsidePath }),
              },
            },
            {
              type: 'function',
              function: {
                name: 'write_file',
                arguments: JSON.stringify({ path: 'missing.md' }),
              },
            },
          ],
        },
      ]);

      const details = await readCliHistoryDetails('a1' as ExecutionId);

      expect(details?.files).toEqual([]);
    });
  });

  it('reports not-found deletion through the structured result', async () => {
    mocks.deleteExecution.mockResolvedValue(false);

    await expect(
      deleteCliHistory({ id: 'abc123' as ExecutionId }),
    ).resolves.toEqual({
      deleted: 'one',
      id: 'abc123',
      found: false,
    });
  });

  it('drops the goal owned by a deleted execution', async () => {
    const streamId = 'chat@deepseek#a1' as StreamTabId;
    await GoalStore.start(streamId, 'finish the cleanup');
    mocks.deleteExecution.mockResolvedValue(true);

    await expect(
      deleteCliHistory({ id: 'a1' as ExecutionId }),
    ).resolves.toEqual({
      deleted: 'one',
      id: 'a1',
      found: true,
    });

    expect(GoalStore.getForStream(streamId)).toBeNull();
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
    mocks.deleteAllExecutions.mockResolvedValue({
      deleted: ['a1', 'b2', 'c3', 'd4'],
      skippedLive: [],
    });

    await expect(deleteCliHistory({ all: true })).resolves.toEqual({
      deleted: 'all',
      count: 4,
      skippedLive: 0,
    });
  });

  it('reuses the preflight count instead of re-listing', async () => {
    mocks.deleteAllExecutions.mockResolvedValue({
      deleted: ['a1'],
      skippedLive: [],
    });

    await expect(
      deleteCliHistory({ all: true, preCountForAll: 7 }),
    ).resolves.toEqual({ deleted: 'all', count: 7, skippedLive: 0 });

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
    mocks.deleteAllExecutions.mockResolvedValue({
      deleted: ['a1', 'b2'],
      skippedLive: [],
    });

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
      mocks.readConfig.mockResolvedValue(null);
      mocks.readConversation.mockResolvedValue(null);
      mocks.readMeta.mockResolvedValue(null);

      await expect(
        readCliHistoryExportInput('missing' as ExecutionId),
      ).resolves.toEqual({ status: 'not_found' });
    });

    it('reports "incomplete" (not "not_found") when config exists but conversation does not', async () => {
      // history show would still display this execution (it has a config) —
      // export just has nothing to render, which is a different failure than
      // the id not resolving to anything at all.
      mocks.readConversation.mockResolvedValue(null);
      mocks.readMeta.mockResolvedValue(null);

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
      mocks.readConfig.mockResolvedValue(null);
      mocks.readConversation.mockResolvedValue([]);
      mocks.readMeta.mockResolvedValue(null);

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
      await withTempDir('texra-history-export-src-', async (resourcesPath) => {
        await withTempDir('texra-history-export-dest-', async (cwd) => {
          const traceViewerDir = path.join(resourcesPath, 'traceViewer');
          await mkdir(traceViewerDir, { recursive: true });
          await writeFile(
            path.join(traceViewerDir, 'index.html'),
            '<html></html>',
          );

          const destDir = path.join(cwd, 'shared-assets');
          const result = await stageCliHistoryTraceViewerAssets({
            resourcesPath,
            destDir,
          });

          expect(result).toBe('staged');
          expect(await readFile(path.join(destDir, 'index.html'), 'utf8')).toBe(
            '<html></html>',
          );
        });
      });
    });

    it('reports "missing" instead of throwing when the bundled trace-viewer assets are absent', async () => {
      await withTempDir(
        'texra-history-export-empty-',
        async (resourcesPath) => {
          await withTempDir('texra-history-export-dest-', async (cwd) => {
            const result = await stageCliHistoryTraceViewerAssets({
              resourcesPath,
              destDir: path.join(cwd, 'shared-assets'),
            });

            expect(result).toBe('missing');
          });
        },
      );
    });

    it('merges into a pre-existing destination directory instead of nesting under it', async () => {
      // A repeat export pointed at the same --assets-dir must not turn
      // `<dir>/assets/index-xxx.js` into `<dir>/traceViewer/assets/index-xxx.js`.
      await withTempDir('texra-history-export-src-', async (resourcesPath) => {
        await withTempDir('texra-history-export-dest-', async (cwd) => {
          const traceViewerDir = path.join(resourcesPath, 'traceViewer');
          await mkdir(path.join(traceViewerDir, 'assets'), {
            recursive: true,
          });
          await writeFile(
            path.join(traceViewerDir, 'index.html'),
            '<html></html>',
          );
          await writeFile(
            path.join(traceViewerDir, 'assets', 'index.js'),
            'js-bytes',
          );

          const destDir = path.join(cwd, 'shared-assets');
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
      });
    });

    it('reads the bundled trace-viewer standalone template', async () => {
      await withTempDir('texra-history-standalone-', async (resourcesPath) => {
        const standaloneDir = path.join(resourcesPath, 'traceViewerStandalone');
        await mkdir(standaloneDir, { recursive: true });
        await writeFile(
          path.join(standaloneDir, 'index.html'),
          '<html>standalone</html>',
        );

        await expect(
          readCliHistoryStandaloneTemplate(resourcesPath),
        ).resolves.toBe('<html>standalone</html>');
      });
    });

    it('returns null instead of throwing when the standalone template is absent', async () => {
      await withTempDir(
        'texra-history-standalone-empty-',
        async (resourcesPath) => {
          await expect(
            readCliHistoryStandaloneTemplate(resourcesPath),
          ).resolves.toBeNull();
        },
      );
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
        stdoutSpy = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation((chunk: unknown) => {
            stdout += String(chunk);
            return true;
          }) as unknown as ReturnType<typeof vi.spyOn>;
        stderrSpy = vi
          .spyOn(process.stderr, 'write')
          .mockImplementation((chunk: unknown) => {
            stderr += String(chunk);
            return true;
          }) as unknown as ReturnType<typeof vi.spyOn>;
      });

      afterEach(() => {
        stdoutSpy.mockRestore();
        stderrSpy.mockRestore();
      });

      it('returns a non-zero exit code (but still writes the trace JSON) when the bundled assets are missing', async () => {
        await withTempDir(
          'texra-history-export-missing-src-',
          async (resourcesPath) => {
            await withTempDir(
              'texra-history-export-missing-dest-',
              async (cwd) => {
                const destDir = path.join(cwd, 'shared-assets');
                const exitCode = await runHistoryExport(
                  makeContext(resourcesPath),
                  'a1' as ExecutionId,
                  'html',
                  { assetsDir: destDir },
                );

                expect(exitCode).toBe(CliExitCode.Usage);
                expect(stdout).toBe(JSON.stringify(trace));
                expect(stderr).toContain('were not found in this CLI install');
              },
            );
          },
        );
      });

      it('returns success and writes a concrete (non-placeholder) instruction when assets stage correctly', async () => {
        await withTempDir(
          'texra-history-export-staged-src-',
          async (resourcesPath) => {
            const traceViewerDir = path.join(resourcesPath, 'traceViewer');
            await mkdir(traceViewerDir, { recursive: true });
            await writeFile(
              path.join(traceViewerDir, 'index.html'),
              '<html></html>',
            );

            await withTempDir(
              'texra-history-export-staged-dest-',
              async (cwd) => {
                const destDir = path.join(cwd, 'shared-assets');
                const exitCode = await runHistoryExport(
                  makeContext(resourcesPath),
                  'a1' as ExecutionId,
                  'html',
                  { assetsDir: destDir },
                );

                expect(exitCode).toBe(CliExitCode.Success);
                expect(stdout).toBe(JSON.stringify(trace));
                // Must not contain the old literal placeholder tokens, which
                // read like an unresolved template rather than instructions.
                expect(stderr).not.toContain('<redirected-path>');
                expect(stderr).not.toContain(
                  '<relative-path-to-the-redirected-file>',
                );
                expect(stderr).toContain(
                  `Wrote trace JSON for a1 to stdout. Save the output to ` +
                    `${path.join(destDir, 'a1.json')}, then open ` +
                    `${destDir}/index.html?trace=a1.json.`,
                );
              },
            );
          },
        );
      });

      it('uses execution-specific trace filenames for repeat exports into the same assets directory', async () => {
        await withTempDir(
          'texra-history-export-repeat-src-',
          async (resourcesPath) => {
            const traceViewerDir = path.join(resourcesPath, 'traceViewer');
            await mkdir(traceViewerDir, { recursive: true });
            await writeFile(
              path.join(traceViewerDir, 'index.html'),
              '<html></html>',
            );

            await withTempDir(
              'texra-history-export-repeat-dest-',
              async (cwd) => {
                const destDir = path.join(cwd, 'shared-assets');
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
              },
            );
          },
        );
      });
    });
  });
});
