// Renders one pending request with the modal its kind takes. The chat's
// approval queue and the attached-task view (`/tasks`) both use it, each
// with its own way of landing the decision.

import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { assertNever } from '@utils/core';
import { AgentProposal } from './AgentProposal';
import { BashApproval } from './BashApproval';
import { EditApproval } from './EditApproval';
import { PlanApproval } from './PlanApproval';
import { RetryRequest } from './RetryRequest';
import { ToolOutcomeRequest } from './ToolOutcomeRequest';
import { UserQuestion } from './UserQuestion';
import type { ApprovalPayload } from '../state/approvalQueue';

export interface ApprovalModalProps {
  readonly availableRows?: number;
  readonly payload: ApprovalPayload;
  /** Land the user's decision on the request. */
  readonly onDecide: (decision: SurfaceDecision) => void;
}

export function ApprovalModal(props: ApprovalModalProps): React.JSX.Element {
  const { payload, onDecide, availableRows } = props;
  switch (payload.kind) {
    case 'bash':
      return (
        <BashApproval
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
    case 'toolEdit':
      return (
        <EditApproval
          availableRows={availableRows}
          payload={payload}
          onDecide={onDecide}
        />
      );
    case 'planApproval':
      return (
        <PlanApproval
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
    case 'proposal':
      return (
        <AgentProposal
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
    case 'retry':
      return (
        <RetryRequest
          availableRows={availableRows}
          payload={payload}
          onDecide={onDecide}
        />
      );
    case 'toolOutcome':
      return (
        <ToolOutcomeRequest
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
    case 'userQuestion':
      return (
        <UserQuestion
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
  }
  return assertNever(payload, 'Unhandled approval payload');
}
