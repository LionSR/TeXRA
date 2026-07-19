// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { ProgressAgentProposalController } from '@controllers/progressView/ProgressAgentProposalController';
import { AgentCategory, type AgentProposalPermission } from '@shared/schemas';
import { DEFAULT_TOOL_CONFIG } from '@shared/schemas/toolConfig';

function createWorkflowProposal(
  overrides: Partial<AgentProposalPermission> = {},
): AgentProposalPermission {
  return {
    proposalId: 'proposal-1',
    streamId: 'stream-1',
    agentCategory: AgentCategory.Workflow,
    agent: 'proofreader',
    model: 'gemini31p',
    instruction: 'Check the paper.',
    inputFiles: ['main.tex', 'appendix.tex'],
    contextFiles: ['refs.bib'],
    mediaFiles: [],
    outputFiles: ['main.review.tex'],
    toolConfig: DEFAULT_TOOL_CONFIG,
    ...overrides,
  } as AgentProposalPermission;
}

describe('ProgressAgentProposalController', () => {
  it('restores pending setup proposals and resolves the coordinator', async () => {
    const proposal = createWorkflowProposal();
    const restored: unknown[] = [];
    const resolved: unknown[] = [];
    const controller = new ProgressAgentProposalController({
      getPendingProposal: () => proposal,
      restoreTaskState: async (taskState) => {
        restored.push(taskState);
        return true;
      },
      settleProposal: (proposalId, result) => {
        resolved.push({ proposalId, result });
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
      agentConfig: {
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
      },
      activeFiles: {
        input: true,
        context: true,
        media: false,
        output: true,
      },
    });
  });

  it('returns false for missing setup proposals', async () => {
    let missingProposalId = '';
    const controller = new ProgressAgentProposalController({
      getPendingProposal: () => undefined,
      restoreTaskState: async () => {
        throw new Error('restore should not run');
      },
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
    const resolved: unknown[] = [];
    const controller = new ProgressAgentProposalController({
      getPendingProposal: () => createWorkflowProposal(),
      restoreTaskState: async () => false,
      settleProposal: (proposalId, result) => {
        resolved.push({ proposalId, result });
      },
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
    const resolved: unknown[] = [];
    const controller = new ProgressAgentProposalController({
      getPendingProposal: () => createWorkflowProposal(),
      restoreTaskState: async () => {
        throw new Error('restore should not run');
      },
      settleProposal: (proposalId, result) => {
        resolved.push({ proposalId, result });
      },
    });

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
    const resolved: { result: Record<string, unknown> }[] = [];
    const controller = new ProgressAgentProposalController({
      getPendingProposal: () => createWorkflowProposal(),
      restoreTaskState: async () => {
        throw new Error('restore should not run');
      },
      settleProposal: (_proposalId, result) => {
        resolved.push({ result });
      },
    });

    await controller.handleAction({
      proposalId: 'proposal-approve',
      action: 'approve',
    });
    await controller.handleAction({
      proposalId: 'proposal-reject',
      action: 'reject',
    });

    assert.deepEqual(resolved, [
      { result: { action: 'approve' } },
      { result: { action: 'reject' } },
    ]);
  });
});
