// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clearInquiryDraft: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock('@shared/hostBridge', () => ({ postMessage: mocks.postMessage }));
vi.mock('@progressView/frontend/components/ExternalInquiryPanel', () => ({
  clearInquiryDraft: mocks.clearInquiryDraft,
}));

// Local imports - progress view
import { handlePermissionAction } from '@progressView/frontend/eventHandlers';
import {
  APPROVE_ALL_DELEGATED_WORK_ACTION,
  APPROVE_SESSION_ACTION,
  type PermissionActionDetail,
  type PermissionDecision,
} from '@progressView/frontend/events';
import type { PermissionState } from '@progressView/frontend/permissionState';
import {
  permissions$,
  resetProgressState,
} from '@progressView/frontend/progressState';

// Local imports - shared contracts
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { AgentCategory } from '@shared/schemas';
import { PERMISSION_KIND } from '@shared/utils/uiConstants';

type PostedCall = [command: string, payload: Record<string, unknown>];
type PermissionCase = {
  name: string;
  detail: PermissionActionDetail;
  calls: PostedCall[];
  remains?: boolean;
  clearedDraft?: string;
};

const toolData = {
  requestId: 'tool-1',
  streamId: 'stream-1',
  allowBypass: true,
  path: '/workspace/paper.tex',
  relativePath: 'paper.tex',
  sourceTool: 'edit_file',
  addedLines: 2,
  removedLines: 1,
  isLatex: true,
};
const bashData = {
  requestId: 'bash-1',
  streamId: 'stream-1',
  allowBypass: true,
  command: 'npm test',
};
const retryData = {
  requestId: 'retry-1',
  streamId: 'stream-1',
  operation: 'stream response',
  model: 'claude-sonnet',
};
const proposalData = {
  proposalId: 'proposal-1',
  streamId: 'stream-1',
  agentCategory: AgentCategory.ToolUse,
  agent: 'researcher',
  agentSource: null,
  model: 'claude-sonnet',
  instruction: 'Check the references.',
  memories: [],
  workingDirectory: null,
  rootUserInstruction: null,
};
const planData = {
  approvalId: 'plan-1',
  streamId: 'stream-1',
  plan: { objective: 'Finish the refactor and verify it.' },
  goalEnabled: true,
};
const inquiryData = {
  requestId: 'inquiry-1',
  streamId: 'stream-1',
  allowBypass: false,
  mode: 'new' as const,
  question: 'Which source should I use?',
  threadId: 'ei_0123456789ab',
  context: null,
  suggestSearch: null,
  attachFiles: null,
  sessionLinks: null,
  draft: null,
  transcript: null,
};
const questionData = {
  requestId: 'question-1',
  streamId: 'stream-1',
  allowBypass: false,
  questions: [
    {
      question: 'Choose a format',
      options: [{ label: 'Short' }, { label: 'Detailed' }],
    },
  ],
  context: null,
};

const detail = {
  tool: (decision: PermissionDecision<'toolEdit'>) =>
    ({ kind: PERMISSION_KIND.TOOL_EDIT, data: toolData, decision }) as const,
  bash: (decision: PermissionDecision<'bash'>) =>
    ({ kind: PERMISSION_KIND.BASH, data: bashData, decision }) as const,
  retry: (decision: PermissionDecision<'retry'>) =>
    ({ kind: PERMISSION_KIND.RETRY, data: retryData, decision }) as const,
  proposal: (decision: PermissionDecision<'proposal'>) =>
    ({
      kind: PERMISSION_KIND.PROPOSAL,
      data: proposalData,
      decision,
    }) as const,
  plan: (decision: PermissionDecision<'planApproval'>) =>
    ({
      kind: PERMISSION_KIND.PLAN_APPROVAL,
      data: planData,
      decision,
    }) as const,
  inquiry: (decision: PermissionDecision<'externalInquiry'>) =>
    ({
      kind: PERMISSION_KIND.EXTERNAL_INQUIRY,
      data: inquiryData,
      decision,
    }) as const,
  question: (decision: PermissionDecision<'userQuestion'>) =>
    ({
      kind: PERMISSION_KIND.USER_QUESTION,
      data: questionData,
      decision,
    }) as const,
};

const call = (
  command: string,
  payload: Record<string, unknown>,
): PostedCall => [command, payload];

const actionCases: PermissionCase[] = [
  {
    name: 'tool approve',
    detail: detail.tool({ action: 'approve' }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
        requestId: 'tool-1',
        action: 'approve',
      }),
    ],
  },
  {
    name: 'tool session approve enables bypass first',
    detail: detail.tool({ action: APPROVE_SESSION_ACTION }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS, {
        stream: 'stream-1',
      }),
      call(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
        requestId: 'tool-1',
        action: 'approve',
      }),
    ],
  },
  {
    name: 'tool reject',
    detail: detail.tool({ action: 'reject', feedback: 'Keep the original.' }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
        requestId: 'tool-1',
        action: 'reject',
        feedback: 'Keep the original.',
      }),
    ],
  },
  ...(['openDiff', 'showLatexdiff', 'previewProposed'] as const).map(
    (action): PermissionCase => ({
      name: `tool ${action} remains open`,
      detail: detail.tool({ action }),
      calls: [
        call(PROGRESS_VIEW_COMMANDS.TOOL_EDIT_APPROVAL_ACTION, {
          requestId: 'tool-1',
          action,
        }),
      ],
      remains: true,
    }),
  ),
  ...(['approve', 'reject'] as const).map((action): PermissionCase => ({
    name: `bash ${action}`,
    detail: detail.bash(
      action === 'reject'
        ? { action, feedback: 'Use a safer command.' }
        : { action },
    ),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION, {
        requestId: 'bash-1',
        action,
        ...(action === 'reject' ? { feedback: 'Use a safer command.' } : {}),
      }),
    ],
  })),
  {
    name: 'bash session approve enables bypass first',
    detail: detail.bash({ action: APPROVE_SESSION_ACTION }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.ENABLE_APPROVAL_BYPASS, {
        stream: 'stream-1',
      }),
      call(PROGRESS_VIEW_COMMANDS.BASH_APPROVAL_ACTION, {
        requestId: 'bash-1',
        action: 'approve',
      }),
    ],
  },
  ...(['retry', 'cancel'] as const).map((action): PermissionCase => ({
    name: `retry ${action}`,
    detail: detail.retry({ action }),
    calls: [
      call(
        action === 'retry'
          ? PROGRESS_VIEW_COMMANDS.RETRY_STREAM_REQUEST
          : PROGRESS_VIEW_COMMANDS.CANCEL_RETRY_REQUEST,
        { stream: 'stream-1', requestId: 'retry-1' },
      ),
    ],
  })),
  {
    name: 'retry API-key selection remains open',
    detail: detail.retry({ action: 'useOwnApiKey' }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.USE_OWN_API_KEY, {
        stream: 'stream-1',
        requestId: 'retry-1',
        model: 'claude-sonnet',
        exhaustionReason: undefined,
        provider: undefined,
        viaRelay: undefined,
      }),
    ],
    remains: true,
  },
  {
    name: 'proposal approve',
    detail: detail.proposal({
      action: 'approve',
      model: 'gpt-5',
      agent: 'reviewer',
    }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
        proposalId: 'proposal-1',
        action: 'approve',
        model: 'gpt-5',
        agent: 'reviewer',
      }),
    ],
  },
  {
    name: 'proposal delegated approval enables bypass first',
    detail: detail.proposal({
      action: APPROVE_ALL_DELEGATED_WORK_ACTION,
      model: 'gpt-5',
      agent: 'reviewer',
    }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.ENABLE_SUPER_YOLO_BYPASS, {
        stream: 'stream-1',
        initiatingProposalId: 'proposal-1',
      }),
      call(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, {
        proposalId: 'proposal-1',
        action: 'approve',
        model: 'gpt-5',
        agent: 'reviewer',
      }),
    ],
  },
  ...(
    [
      [{ action: 'setup' }, { proposalId: 'proposal-1', action: 'setup' }],
      [
        { action: 'reject', feedback: 'Use the existing agent.' },
        {
          proposalId: 'proposal-1',
          action: 'reject',
          feedback: 'Use the existing agent.',
        },
      ],
    ] as const
  ).map(([decision, payload]): PermissionCase => ({
    name: `proposal ${decision.action}`,
    detail: detail.proposal(decision),
    calls: [call(PROGRESS_VIEW_COMMANDS.AGENT_PROPOSAL_ACTION, payload)],
  })),
  ...(
    [
      [{ action: 'approve' }, { approvalId: 'plan-1', action: 'approve' }],
      [
        { action: 'approve_and_goal' },
        { approvalId: 'plan-1', action: 'approve_and_goal' },
      ],
      [
        { action: 'reject', feedback: 'Add verification.' },
        {
          approvalId: 'plan-1',
          action: 'reject',
          feedback: 'Add verification.',
        },
      ],
    ] as const
  ).map(([decision, payload]): PermissionCase => ({
    name: `plan ${decision.action}`,
    detail: detail.plan(decision),
    calls: [call(PROGRESS_VIEW_COMMANDS.PLAN_APPROVAL_ACTION, payload)],
  })),
  {
    name: 'external inquiry submit',
    detail: detail.inquiry({
      action: 'submit',
      answer: 'Use the project documentation.',
      sessionLinks: ['session-7'],
    }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION, {
        action: 'submit',
        threadId: 'ei_0123456789ab',
        answer: 'Use the project documentation.',
        sessionLinks: ['session-7'],
      }),
    ],
    clearedDraft: 'inquiry-1',
  },
  {
    name: 'external inquiry reject',
    detail: detail.inquiry({ action: 'reject', feedback: 'Not needed.' }),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.EXTERNAL_INQUIRY_ACTION, {
        action: 'drop',
        threadId: 'ei_0123456789ab',
        feedback: 'Not needed.',
      }),
    ],
    clearedDraft: 'inquiry-1',
  },
  ...(
    [
      { action: 'submit', answers: { 'Choose a format': 'Short' } },
      { action: 'reject', feedback: 'Ask later.' },
      { action: 'skip', feedback: 'Use the default.' },
    ] as const
  ).map((decision): PermissionCase => ({
    name: `user question ${decision.action}`,
    detail: detail.question(decision),
    calls: [
      call(PROGRESS_VIEW_COMMANDS.USER_QUESTION_ACTION, {
        requestId: 'question-1',
        ...decision,
      }),
    ],
  })),
];

function permissionFrom(detail: PermissionActionDetail): PermissionState {
  const { decision: _decision, ...permission } = detail;
  return permission;
}

describe('permission action event handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProgressState();
  });

  it.each(actionCases)('$name', ({ detail, calls, remains, clearedDraft }) => {
    const permission = permissionFrom(detail);
    permissions$.set([permission]);

    handlePermissionAction({ detail } as CustomEvent<PermissionActionDetail>);

    expect(mocks.postMessage.mock.calls).toEqual(calls);
    expect(permissions$.get()).toEqual(remains ? [permission] : []);
    if (clearedDraft) {
      expect(mocks.clearInquiryDraft).toHaveBeenCalledWith(clearedDraft);
    } else {
      expect(mocks.clearInquiryDraft).not.toHaveBeenCalled();
    }
  });
});
