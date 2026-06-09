// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { createProgressViewApprovalCommandHandlers } from '@controllers/progressView/ProgressViewApprovalCommandHandlers';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { dispatchProgressViewInbound } from '@shared/schemas/progressView';

describe('createProgressViewApprovalCommandHandlers', () => {
  it('routes progress approval commands to host actions', async () => {
    const actions = {
      handleToolEditApprovalAction: vi.fn(() => true),
      onUnsupportedToolEditApproval: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    };
    const handlers = createProgressViewApprovalCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-1',
          action: 'approve',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
          requestId: 'bash-1',
          action: 'reject',
          feedback: 'needs a smaller command',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
          approvalId: 'plan-1',
          action: 'approve_and_goal',
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
          requestId: 'question-1',
          action: 'submit',
          answers: { answer: 'yes' },
        },
        handlers,
      ),
    ).toBe(true);
    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
          proposalId: 'proposal-1',
          action: 'setup',
          agent: 'review',
          model: 'deepseek',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.handleToolEditApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId: 'edit-1',
      action: 'approve',
    });
    expect(actions.handleBashApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION,
      requestId: 'bash-1',
      action: 'reject',
      feedback: 'needs a smaller command',
    });
    expect(actions.handlePlanApprovalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION,
      approvalId: 'plan-1',
      action: 'approve_and_goal',
    });
    expect(actions.handleUserQuestionAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION,
      requestId: 'question-1',
      action: 'submit',
      answers: { answer: 'yes' },
    });
    expect(actions.handleAgentProposalAction).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION,
      proposalId: 'proposal-1',
      action: 'setup',
      agent: 'review',
      model: 'deepseek',
    });
    expect(actions.onUnsupportedToolEditApproval).not.toHaveBeenCalled();
    expect(handlers[PROGRESS_VIEW_COMMANDS.OPEN_FILE]).toBeUndefined();
  });

  it('reports unsupported tool-edit approval actions when the host returns false', async () => {
    const actions = {
      handleToolEditApprovalAction: vi.fn(() => false),
      onUnsupportedToolEditApproval: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    };
    const handlers = createProgressViewApprovalCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-2',
          action: 'openDiff',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.onUnsupportedToolEditApproval).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId: 'edit-2',
      action: 'openDiff',
    });
  });

  it('reports unsupported tool-edit approval actions from async host results', async () => {
    const actions = {
      handleToolEditApprovalAction: vi.fn(() => Promise.resolve(false)),
      onUnsupportedToolEditApproval: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    };
    const handlers = createProgressViewApprovalCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-3',
          action: 'approve',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.onUnsupportedToolEditApproval).toHaveBeenCalledWith({
      command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
      requestId: 'edit-3',
      action: 'approve',
    });
  });

  it('does not report unsupported tool-edit approval actions from async handled results', async () => {
    const actions = {
      handleToolEditApprovalAction: vi.fn(() => Promise.resolve(true)),
      onUnsupportedToolEditApproval: vi.fn(),
      handleBashApprovalAction: vi.fn(),
      handlePlanApprovalAction: vi.fn(),
      handleUserQuestionAction: vi.fn(),
      handleAgentProposalAction: vi.fn(),
    };
    const handlers = createProgressViewApprovalCommandHandlers(actions);

    expect(
      dispatchProgressViewInbound(
        {
          command: PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION,
          requestId: 'edit-4',
          action: 'reject',
        },
        handlers,
      ),
    ).toBe(true);

    await Promise.resolve();

    expect(actions.onUnsupportedToolEditApproval).not.toHaveBeenCalled();
  });
});
