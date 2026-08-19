import { strict as assert } from 'node:assert';

import { beforeEach, describe, it, vi } from 'vitest';

const tryResumeStreamMock = vi.hoisted(() =>
  vi.fn(async (_streamId: string) => true),
);

vi.mock('@platform/platform', () => ({
  platform: () => ({ agentResume: { tryResumeStream: tryResumeStreamMock } }),
}));

import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { createProgressViewCommandHandlers } from '@controllers/progressView/ProgressViewCommandHandlers';
import { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory, type RunIdentity } from '@shared/schemas';
import {
  createAgentConfig,
  createWorkflowConfig,
} from '../support/ProgressControllerHarnesses';

interface HostHarness {
  readonly handlers: ReturnType<typeof createProgressViewCommandHandlers>;
  readonly executed: unknown[];
  readonly metadataReads: string[];
  readonly openedLabels: string[];
  readonly infoMessages: string[];
  readonly bypassInfoMessages: string[];
  readonly settledProposals: unknown[];
}

function createHostHarness(
  runConfig: AgentConfig,
  identity?: RunIdentity,
): HostHarness {
  const executed: unknown[] = [];
  const metadataReads: string[] = [];
  const openedLabels: string[] = [];
  const infoMessages: string[] = [];
  const bypassInfoMessages: string[] = [];
  const settledProposals: unknown[] = [];

  const handlers = createProgressViewCommandHandlers({
    run: {
      state: {
        getRunMetadata: (stream) => {
          metadataReads.push(stream);
          return {
            config: runConfig,
            identity: identity ?? { kind: 'agent', agent: runConfig.agent },
            executionId: 'exec-1',
          };
        },
      },
      runExecutionRequest: async (request) => {
        executed.push(request);
      },
    },
    workflowFileActions: new ProgressWorkflowFileActionsController({
      state: {
        getActiveStream: () => 'stream-a',
        getRunMetadata: () => ({ executionId: 'exec-1' }),
        getOutputFiles: () => ({}),
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
    }),
    agentProposal: new ProgressAgentProposalController({
      getPendingProposal: () => undefined,
      restoreRunConfig: async () => false,
      openFile: vi.fn(),
      settleProposal: (requestId, result) => {
        settledProposals.push({ requestId, result });
      },
    }),
    lifecycle: {
      setActiveStream: vi.fn(),
      deleteStream: vi.fn(),
      deleteAllStreams: vi.fn(),
      stopStream: vi.fn(),
    },
    followUp: {
      sendFollowUp: vi.fn(),
      reportImageSaveError: vi.fn(),
    },
    bypass: {
      showInfo: (message: string) => {
        bypassInfoMessages.push(message);
      },
    },
    file: {
      openFile: vi.fn(),
      openSpillArtifact: vi.fn(),
    },
    approval: {
      approvePendingDelegatedWork: vi.fn(async () => undefined),
      handleToolEditApprovalAction: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
    },
    externalInquiry: {
      dismiss: vi.fn(),
    },
  });

  return {
    handlers,
    executed,
    metadataReads,
    openedLabels,
    infoMessages,
    bypassInfoMessages,
    settledProposals,
  };
}

function createToolUseHostHarness(identity?: RunIdentity): HostHarness {
  return createHostHarness(
    createAgentConfig({ agentCategory: AgentCategory.ToolUse }),
    identity,
  );
}

describe('progress view run commands', () => {
  beforeEach(() => {
    tryResumeStreamMock.mockClear();
  });

  it('routes run, label, and proposal commands through the shared controllers', async () => {
    const runConfig = createWorkflowConfig();
    const harness = createHostHarness(runConfig);
    const { handlers } = harness;

    await handlers[PROGRESS_VIEW_COMMANDS.RUN_NEW]?.({
      command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
      stream: 'stream-a',
    });
    await handlers[PROGRESS_VIEW_COMMANDS.RESUME]?.({
      command: PROGRESS_VIEW_COMMANDS.RESUME,
      stream: 'stream-a',
    });
    await handlers[PROGRESS_VIEW_COMMANDS.OPEN_LABEL]?.({
      command: PROGRESS_VIEW_COMMANDS.OPEN_LABEL,
      label: 'main-thm',
    });
    await handlers[PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION]?.({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      requestId: 'proposal-1',
      action: 'approve',
    });

    assert.deepEqual(harness.executed, [
      { config: runConfig },
      { config: runConfig, executionId: 'exec-1' },
    ]);
    assert.deepEqual(harness.metadataReads, ['stream-a', 'stream-a']);
    assert.equal(tryResumeStreamMock.mock.calls.length, 0);
    assert.deepEqual(harness.openedLabels, ['main-thm']);
    assert.deepEqual(harness.infoMessages, ['Label "main-thm" not found.']);
    assert.deepEqual(harness.settledProposals, [
      {
        requestId: 'proposal-1',
        result: { action: 'approve' },
      },
    ]);
  });

  it('resumes a tool-use stream through the host resume port', async () => {
    const harness = createToolUseHostHarness();

    await harness.handlers[PROGRESS_VIEW_COMMANDS.RESUME]?.({
      command: PROGRESS_VIEW_COMMANDS.RESUME,
      stream: 'stream-a',
    });

    assert.deepEqual(tryResumeStreamMock.mock.calls, [['stream-a']]);
    assert.deepEqual(harness.executed, []);
    assert.deepEqual(harness.metadataReads, ['stream-a']);
  });

  it('starts a fresh run for a tool-use stream on Run New', async () => {
    const runConfig = createAgentConfig({
      agentCategory: AgentCategory.ToolUse,
    });
    const harness = createHostHarness(runConfig);

    await harness.handlers[PROGRESS_VIEW_COMMANDS.RUN_NEW]?.({
      command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
      stream: 'stream-a',
    });

    assert.deepEqual(harness.executed, [{ config: runConfig }]);
    assert.equal(tryResumeStreamMock.mock.calls.length, 0);
  });

  // Defect 3 of the run-classification consolidation: resume/re-run must be
  // refused — with feedback, never a silent no-op relaunch of the stored
  // config — for every non-native identity.
  const nonNativeIdentities: readonly RunIdentity[] = [
    { kind: 'multiAgentWorkflow', workflowName: 'engineer' },
    { kind: 'process', tool: 'bash' },
    { kind: 'agent', agent: 'coder', tool: 'codex' },
  ];

  for (const identity of nonNativeIdentities) {
    it(`refuses RESUME and RUN_NEW with feedback for ${JSON.stringify(identity)}`, async () => {
      const harness = createToolUseHostHarness(identity);

      await harness.handlers[PROGRESS_VIEW_COMMANDS.RESUME]?.({
        command: PROGRESS_VIEW_COMMANDS.RESUME,
        stream: 'stream-a',
      });
      await harness.handlers[PROGRESS_VIEW_COMMANDS.RUN_NEW]?.({
        command: PROGRESS_VIEW_COMMANDS.RUN_NEW,
        stream: 'stream-a',
      });

      assert.deepEqual(harness.executed, []);
      assert.equal(tryResumeStreamMock.mock.calls.length, 0);
      assert.equal(harness.bypassInfoMessages.length, 2);
      for (const message of harness.bypassInfoMessages) {
        assert.match(message, /Only TeXRA agent runs/);
      }
    });
  }
});
