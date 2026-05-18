import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { ExecutionId } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

const mocks = vi.hoisted(() => ({
  readConfig: vi.fn(),
  readMeta: vi.fn(),
  readResultMeta: vi.fn(),
  readReport: vi.fn(),
  exists: vi.fn(),
  listExecutions: vi.fn(),
  deleteExecution: vi.fn(),
  deleteAllExecutions: vi.fn(),
}));

vi.mock('@agent/storage', () => ({
  getExecutionStore: vi.fn(() => ({
    readConfig: mocks.readConfig,
    readMeta: mocks.readMeta,
    readResultMeta: mocks.readResultMeta,
    readReport: mocks.readReport,
    exists: mocks.exists,
  })),
  listExecutions: mocks.listExecutions,
  deleteExecution: mocks.deleteExecution,
  deleteAllExecutions: mocks.deleteAllExecutions,
}));

vi.mock('@utils/files/taskRunStorage', () => ({
  resolveStoragePath: vi.fn(async () => undefined),
}));

import {
  cliHistoryNdjsonRecords,
  deleteCliHistory,
  formatCliHistoryText,
  listCliHistoryEntries,
  parseCliHistoryId,
  readCliHistoryConfig,
  readCliHistoryDetails,
} from '../../../packages/cli/src/runtime/history';

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

describe('CLI history runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfig.mockResolvedValue(config);
    mocks.readMeta.mockResolvedValue(null);
    mocks.readResultMeta.mockResolvedValue(null);
    mocks.readReport.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);
  });

  it('formats history list rows with the stable tab-separated text shape', async () => {
    mocks.listExecutions.mockResolvedValue([
      {
        id: 'a1' as ExecutionId,
        timestamp: '2026-05-18T08:00:00.000Z',
        agent: 'correct',
        model: 'deepseekT',
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
  });

  it('returns null for ids without persisted metadata, config, or flow state', async () => {
    mocks.readConfig.mockResolvedValue(null);
    mocks.readMeta.mockResolvedValue(null);
    mocks.exists.mockResolvedValue(false);

    await expect(
      readCliHistoryDetails('dead' as ExecutionId),
    ).resolves.toBeNull();
  });

  it('loads the stored config used by resume', async () => {
    await expect(readCliHistoryConfig('a1' as ExecutionId)).resolves.toEqual(
      config,
    );
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

  it('validates execution id shape before command handlers use storage', () => {
    expect(parseCliHistoryId('abc123')).toBe('abc123');
    expect(parseCliHistoryId('../abc123')).toBeUndefined();
  });
});
