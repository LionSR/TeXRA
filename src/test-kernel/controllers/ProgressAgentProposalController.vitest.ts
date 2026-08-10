// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import {
  ProgressAgentProposalController,
  type ProgressAgentProposalControllerDeps,
} from '@controllers/progressView/ProgressAgentProposalController';
import { AgentCategory, type AgentProposalPermission } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';
import { resolveWorkspaceRelativePath } from '@tools/pathResolution';

function createWorkflowProposal(): AgentProposalPermission {
  return {
    proposalId: 'proposal-1',
    streamId: 'stream-1',
    agentCategory: AgentCategory.Workflow,
    agent: 'proofreader',
    model: 'gemini31p',
    instruction: 'Check the paper.',
    memories: [],
    inputFiles: ['main.tex', 'appendix.tex'],
    contextFiles: ['refs.bib'],
    mediaFiles: [],
    outputFiles: ['main.review.tex'],
    toolConfig: DEFAULT_TOOL_CONFIG,
  };
}

function createController(
  overrides: Partial<ProgressAgentProposalControllerDeps> = {},
): {
  controller: ProgressAgentProposalController;
  resolved: { proposalId: string; result: unknown }[];
} {
  const resolved: { proposalId: string; result: unknown }[] = [];
  const controller = new ProgressAgentProposalController({
    getPendingProposal: () => createWorkflowProposal(),
    restoreRunConfig: async () => {
      throw new Error('restore should not run');
    },
    openFile: async () => {
      throw new Error('open should not run');
    },
    settleProposal: (proposalId, result) => {
      resolved.push({ proposalId, result });
    },
    ...overrides,
  });
  return { controller, resolved };
}

describe('ProgressAgentProposalController', () => {
  it('restores pending setup proposals and resolves the coordinator', async () => {
    const proposal = createWorkflowProposal();
    const restored: unknown[] = [];
    const { controller, resolved } = createController({
      getPendingProposal: () => proposal,
      restoreRunConfig: async (config) => {
        restored.push(config);
        return true;
      },
    });

    assert.equal(
      await controller.handleAction({
        proposalId: proposal.proposalId,
        action: 'setup',
      }),
      true,
    );
    assert.equal(restored.length, 1);
    assert.deepEqual(resolved, [
      { proposalId: 'proposal-1', result: { action: 'setup' } },
    ]);
    assert.deepEqual(restored[0], {
      agentCategory: AgentCategory.Workflow,
      agent: 'proofreader',
      model: 'gemini31p',
      instruction: 'Check the paper.',
      inputFiles: ['main.tex', 'appendix.tex'],
      contextFiles: ['refs.bib'],
      mediaFiles: [],
      outputFiles: ['main.review.tex'],
      toolConfig: DEFAULT_TOOL_CONFIG,
      editedFile: null,
      editedFiles: [],
      memories: [],
    });
  });

  it('opens the saved workflow script instead of restoring a run config on setup', async () => {
    const base = createWorkflowProposal();
    if (base.agentCategory !== AgentCategory.Workflow) {
      throw new Error('expected workflow proposal');
    }
    const proposal = {
      ...base,
      workingDirectory: '.texra/worktrees/review',
      workflowScript: {
        name: 'review-team',
        description: 'Review in parallel',
        scriptPath: '.texra/workflow-scripts/review-team.mjs',
        phases: [{ title: 'Review' }],
        tasks: [{ id: 'review', label: 'Review draft', phase: 'Review' }],
      },
    } satisfies AgentProposalPermission;
    const opened: string[] = [];
    const { controller, resolved } = createController({
      getPendingProposal: () => proposal,
      openFile: async (path) => {
        opened.push(path);
      },
    });

    assert.equal(
      await controller.handleAction({
        proposalId: proposal.proposalId,
        action: 'setup',
      }),
      true,
    );
    assert.deepEqual(opened, [
      resolveWorkspaceRelativePath(
        proposal.workflowScript.scriptPath,
        proposal.workingDirectory,
      ).fsPath,
    ]);
    assert.deepEqual(resolved, [
      { proposalId: 'proposal-1', result: { action: 'setup' } },
    ]);
  });

  it('rejects setup when the saved workflow script cannot be opened', async () => {
    const base = createWorkflowProposal();
    if (base.agentCategory !== AgentCategory.Workflow) {
      throw new Error('expected workflow proposal');
    }
    const proposal = {
      ...base,
      workflowScript: {
        name: 'review-team',
        description: 'Review in parallel',
        scriptPath: '.texra/workflow-scripts/review-team.mjs',
        phases: [{ title: 'Review' }],
        tasks: [{ id: 'review', label: 'Review draft', phase: 'Review' }],
      },
    } satisfies AgentProposalPermission;
    const { controller, resolved } = createController({
      getPendingProposal: () => proposal,
      openFile: async () => {
        throw new Error('file is unavailable');
      },
    });

    assert.equal(
      await controller.handleAction({
        proposalId: proposal.proposalId,
        action: 'setup',
      }),
      false,
    );
    assert.deepEqual(resolved, [
      {
        proposalId: 'proposal-1',
        result: {
          action: 'reject',
          feedback:
            'Unable to open the workflow script for setup: file is unavailable',
        },
      },
    ]);
  });

  it('returns false for missing setup proposals', async () => {
    let missingProposalId = '';
    const { controller } = createController({
      getPendingProposal: () => undefined,
      settleProposal: () => {
        throw new Error('resolve should not run');
      },
      onMissingProposal: (proposalId) => {
        missingProposalId = proposalId;
      },
    });

    assert.equal(
      await controller.handleAction({
        proposalId: 'missing-proposal',
        action: 'setup',
      }),
      false,
    );
    assert.equal(missingProposalId, 'missing-proposal');
  });

  it('rejects pending setup proposals when restore fails', async () => {
    const { controller, resolved } = createController({
      restoreRunConfig: async () => false,
    });

    assert.equal(
      await controller.handleAction({
        proposalId: 'proposal-1',
        action: 'setup',
      }),
      false,
    );
    assert.deepEqual(resolved, [
      {
        proposalId: 'proposal-1',
        result: {
          action: 'reject',
          feedback: 'Unable to restore the proposal configuration for setup.',
        },
      },
    ]);
  });

  it('passes approve and reject actions through without restoring state', async () => {
    const { controller, resolved } = createController();

    assert.equal(
      await controller.handleAction({
        proposalId: 'proposal-approve',
        action: 'approve',
        model: 'gpt-5.4',
        agent: 'critic',
      }),
      true,
    );
    assert.equal(
      await controller.handleAction({
        proposalId: 'proposal-reject',
        action: 'reject',
        feedback: 'too broad',
      }),
      true,
    );
    assert.deepEqual(resolved, [
      {
        proposalId: 'proposal-approve',
        result: { action: 'approve', model: 'gpt-5.4', agent: 'critic' },
      },
      {
        proposalId: 'proposal-reject',
        result: { action: 'reject', feedback: 'too broad' },
      },
    ]);
  });

  it('omits absent optional fields when approving or rejecting', async () => {
    const { controller, resolved } = createController();

    await controller.handleAction({
      proposalId: 'proposal-approve',
      action: 'approve',
    });
    await controller.handleAction({
      proposalId: 'proposal-reject',
      action: 'reject',
    });

    assert.deepEqual(resolved, [
      { proposalId: 'proposal-approve', result: { action: 'approve' } },
      { proposalId: 'proposal-reject', result: { action: 'reject' } },
    ]);
  });
});
