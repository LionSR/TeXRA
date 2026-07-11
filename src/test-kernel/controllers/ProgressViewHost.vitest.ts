// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it, vi } from 'vitest';

// Local imports - controllers
import { ProgressViewHost } from '@controllers/progressView/ProgressViewHost';
import type { TaskState } from '@agent/core/state/TaskState';

// Local imports - shared
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - test support
import { createWorkflowTaskState } from '../support/ProgressControllerHarnesses';

function createTaskState(): TaskState {
  return createWorkflowTaskState();
}

describe('ProgressViewHost', () => {
  it('constructs shared controllers and command handlers from host adapters', async () => {
    const taskState = createTaskState();
    const executed: unknown[] = [];
    const openedLabels: string[] = [];
    const infoMessages: string[] = [];
    const settledProposals: unknown[] = [];

    const host = new ProgressViewHost({
      workflowActions: {
        state: {
          getTaskState: () => taskState,
          getExecutionId: () => 'exec-1',
          getOutputFiles: () => ({}),
          getKnownWorkspaceOutputPaths: () => new Set(),
        },
        executeAgent: async (request) => {
          executed.push(request);
        },
        runDiff: vi.fn(),
        runFileOperation: vi.fn(),
      },
      workflowFileActions: {
        state: {
          getActiveStream: () => 'stream-a',
          getExecutionId: () => 'exec-1',
          getOutputFiles: () => ({}),
          getAgentModel: () => undefined,
        },
        host: {
          compareFiles: vi.fn(),
          acceptEditedFile: vi.fn(),
          mergeFile: vi.fn(),
          latexdiffFile: vi.fn(),
          openDirectory: vi.fn(),
          openLabel: async (label) => {
            openedLabels.push(label);
            return false;
          },
          readFile: async () => '',
          showInfo: async (message) => {
            infoMessages.push(message);
          },
          showError: vi.fn(),
        },
        sendFollowUp: vi.fn(),
      },
      agentProposal: {
        getPendingProposal: () => undefined,
        restoreTaskState: async () => false,
        settleProposal: (proposalId, result) => {
          settledProposals.push({ proposalId, result });
        },
      },
      commands: {
        lifecycle: {
          setActiveStream: vi.fn(),
          setAgentFilter: vi.fn(),
          deleteStream: vi.fn(),
          deleteAllStreams: vi.fn(),
          stopStream: vi.fn(),
        },
        followUp: {
          sendFollowUp: vi.fn(),
          reportImageSaveError: vi.fn(),
        },
        bypass: {
          runtimeHost: { emit: vi.fn() },
        },
        file: {
          openFile: vi.fn(),
          openFileCompile: vi.fn(),
        },
        approval: {
          handleToolEditApprovalAction: vi.fn(),
          handleBashApprovalAction: vi.fn(),
          handlePlanApprovalAction: vi.fn(),
          handleUserQuestionAction: vi.fn(),
        },
        externalInquiry: {},
      },
    });

    await host.commandHandlers[PROGRESS_VIEW_COMMANDS.RUN_NEW]?.({
      command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
      stream: 'stream-a',
    });
    await host.commandHandlers[PROGRESS_VIEW_COMMANDS.OPEN_LABEL]?.({
      command: PROGRESS_VIEW_COMMANDS.OPEN_LABEL,
      label: 'main-thm',
    });
    await host.commandHandlers[PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]?.({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'approve',
    });

    assert.deepEqual(executed, [{ config: taskState.agentConfig }]);
    assert.deepEqual(openedLabels, ['main-thm']);
    assert.deepEqual(infoMessages, ['Label "main-thm" not found.']);
    assert.deepEqual(settledProposals, [
      {
        proposalId: 'proposal-1',
        result: { action: 'approve' },
      },
    ]);
  });
});
