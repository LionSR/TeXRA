// Test-only builder for the seven-kind `ApprovalRequestHandlerSet` that
// `createExtensionHostInteractions` requires. Every kind must be a real
// `ApprovalRequestHandler` because `HostInteractions.cancel()` (run on session
// disposal) reaches all of them unconditionally; each is wired to a recording
// transport so a suite can assert on show/dismiss without rebuilding the set.

// Third-party imports
import { vi } from 'vitest';

// Local imports
import type {
  BashSettlement,
  PlanApprovalResult,
  ProposalResult,
  RetryResult,
  UserQuestionSettlement,
} from '@agent/runtime/HostInteractions';
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { ApprovalRequestHandlerSet } from '@controllers/progressView/backend/progressBackendUiConfig';
import type {
  AgentProposalPermission,
  BashPermission,
  ExternalInquiryPermission,
  PlanApprovalPermission,
  RetryPermission,
  ToolEditPermission,
  UserQuestionPermission,
} from '@shared/schemas';

type ShowSpy<T> = ReturnType<typeof vi.fn<(item: T) => void>>;
type DismissSpy = ReturnType<typeof vi.fn<(id: string) => void>>;

interface RecordingTransport<T> {
  readonly show: ShowSpy<T>;
  readonly dismiss: DismissSpy;
}

interface RecordingApprovalHandlerSet extends ApprovalRequestHandlerSet {
  readonly transport: {
    toolEdit: RecordingTransport<ToolEditPermission>;
    bash: RecordingTransport<BashPermission>;
    retry: RecordingTransport<RetryPermission>;
    proposal: RecordingTransport<AgentProposalPermission>;
    planApproval: RecordingTransport<PlanApprovalPermission>;
    externalInquiry: RecordingTransport<ExternalInquiryPermission>;
    userQuestion: RecordingTransport<UserQuestionPermission>;
  };
}

function handler<
  T extends { streamId: string },
  K extends keyof T,
  Result = never,
>(
  idField: K,
): {
  handler: ApprovalRequestHandler<T, K, Result>;
  transport: RecordingTransport<T>;
} {
  const transport = {
    show: vi.fn<(item: T) => void>(),
    dismiss: vi.fn<(id: string) => void>(),
  };
  return {
    handler: new ApprovalRequestHandler<T, K, Result>(
      idField,
      transport.show,
      transport.dismiss,
      () => true,
    ),
    transport,
  };
}

export function createRecordingApprovalHandlers(): RecordingApprovalHandlerSet {
  const toolEdit = handler<ToolEditPermission, 'requestId'>('requestId');
  const bash = handler<BashPermission, 'requestId', BashSettlement>(
    'requestId',
  );
  const retry = handler<RetryPermission, 'streamId', RetryResult>('streamId');
  const proposal = handler<
    AgentProposalPermission,
    'requestId',
    ProposalResult
  >('requestId');
  const planApproval = handler<
    PlanApprovalPermission,
    'requestId',
    PlanApprovalResult
  >('requestId');
  const externalInquiry = handler<ExternalInquiryPermission, 'requestId'>(
    'requestId',
  );
  const userQuestion = handler<
    UserQuestionPermission,
    'requestId',
    UserQuestionSettlement
  >('requestId');

  return {
    toolEdit: toolEdit.handler,
    bash: bash.handler,
    retry: retry.handler,
    proposal: proposal.handler,
    planApproval: planApproval.handler,
    externalInquiry: externalInquiry.handler,
    userQuestion: userQuestion.handler,
    transport: {
      toolEdit: toolEdit.transport,
      bash: bash.transport,
      retry: retry.transport,
      proposal: proposal.transport,
      planApproval: planApproval.transport,
      externalInquiry: externalInquiry.transport,
      userQuestion: userQuestion.transport,
    },
  };
}
