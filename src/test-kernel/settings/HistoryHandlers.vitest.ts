import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RESUMABILITY_CAUSE } from '@agent/storage';
import { buildHistoryMessage } from '@controllers/settingsView/HistoryMessageBuilder';
import { AgentCategory } from '@shared/schemas/agent';
import { HISTORY_RUN_STATUS } from '@shared/schemas/historyViewMessages';
import { RUN_OUTCOME } from '@shared/schemas/stream';

const mocks = vi.hoisted(() => ({
  listExecutions: vi.fn(),
  readWorkspaceFiles: vi.fn(),
  deriveResumability: vi.fn(),
}));

vi.mock('@agent/storage', async () => {
  const actual =
    await vi.importActual<typeof import('@agent/storage')>('@agent/storage');
  return {
    ...actual,
    getExecutionStore: vi.fn(() => ({
      readWorkspaceFiles: mocks.readWorkspaceFiles,
    })),
    listExecutions: mocks.listExecutions,
    deriveResumability: mocks.deriveResumability,
  };
});

const toolUseExecution = {
  kind: 'run',
  identity: { kind: 'agent', agent: 'chat' },
  id: 'abc123',
  timestamp: '2026-05-31T12:00:00.000Z',
  record: {
    agent: 'chat',
    model: 'deepseekT',
    instruction: 'Check a proof.',
    agentCategory: AgentCategory.ToolUse,
  },
};

describe('settings history handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readWorkspaceFiles.mockResolvedValue([]);
    mocks.deriveResumability.mockResolvedValue({
      resumable: false,
      cause: RESUMABILITY_CAUSE.TERMINAL_COMPLETED,
      outcome: RUN_OUTCOME.COMPLETED,
    });
  });

  it('includes persisted edited files for tool-use history items', async () => {
    mocks.listExecutions.mockResolvedValue([toolUseExecution]);
    mocks.readWorkspaceFiles.mockResolvedValue(['proofs/lemma.md']);

    const message = await buildHistoryMessage();

    expect(message.historyItems).toEqual([
      {
        id: 'abc123',
        timestamp: '2026-05-31T12:00:00.000Z',
        status: HISTORY_RUN_STATUS.COMPLETED,
        agentConfig: {
          agentCategory: 'toolUse',
          agent: 'chat',
          model: 'deepseekT',
          instruction: 'Check a proof.',
          editedFiles: ['proofs/lemma.md'],
        },
        description: undefined,
      },
    ]);
  });

  it('hides internal process-bookkeeping and configless entries', async () => {
    mocks.listExecutions.mockResolvedValue([
      toolUseExecution,
      {
        kind: 'run',
        identity: { kind: 'process', tool: 'bash' },
        id: 'bash-process',
        timestamp: '2026-05-31T12:01:00.000Z',
        record: {
          agent: 'bash',
          model: 'deepseekT',
          instruction: 'ls -la',
          agentCategory: AgentCategory.ToolUse,
        },
      },
      {
        kind: 'incomplete',
        id: 'configless',
        timestamp: '2026-05-31T12:02:00.000Z',
      },
    ]);

    const message = await buildHistoryMessage();

    expect(message.historyItems.map((item) => item.id)).toEqual(['abc123']);
  });

  it('hides agent-spawned child runs', async () => {
    mocks.listExecutions.mockResolvedValue([
      toolUseExecution,
      {
        ...toolUseExecution,
        id: 'delegated-child',
        timestamp: '2026-05-31T12:03:00.000Z',
        parentExecutionId: 'abc123',
      },
    ]);

    const message = await buildHistoryMessage();

    expect(message.historyItems.map((item) => item.id)).toEqual(['abc123']);
  });

  it.each([
    [
      'reports a resumable run as resumable rather than by its terminal outcome',
      {
        resumable: true,
        cause: RESUMABILITY_CAUSE.INTERRUPTED_WITH_FLOW,
        flowRecord: { flowName: 'tooluse', params: {}, shared: {}, nodes: [] },
        outcome: RUN_OUTCOME.CANCELLED,
      },
      HISTORY_RUN_STATUS.RESUMABLE,
    ],
    [
      'keeps cancelled distinct from failed and completed',
      {
        resumable: false,
        cause: RESUMABILITY_CAUSE.MISSING_FLOW,
        outcome: RUN_OUTCOME.CANCELLED,
      },
      HISTORY_RUN_STATUS.CANCELLED,
    ],
    [
      // Crash-masking guard, matching the CLI: an absent outcome means the
      // run never reached its terminal write (crash, kill, old build).
      'reports a run whose terminal write never landed as unknown, not completed',
      {
        resumable: false,
        cause: RESUMABILITY_CAUSE.MISSING_FLOW,
      },
      HISTORY_RUN_STATUS.UNKNOWN,
    ],
  ])('%s', async (_name, resumability, expectedStatus) => {
    mocks.listExecutions.mockResolvedValue([toolUseExecution]);
    mocks.deriveResumability.mockResolvedValue(resumability);

    const message = await buildHistoryMessage();

    expect(message.historyItems[0]?.status).toBe(expectedStatus);
  });
});
