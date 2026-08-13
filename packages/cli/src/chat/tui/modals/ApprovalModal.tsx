// Dispatches the head item of the approval queue to the right modal.
//
// The `pending` slot is passed in as a prop so the parent owns the single
// `useSignal(currentApproval)` subscription — avoids a second store read
// every render.

import { assertNever } from '@utils/core';
import { AgentProposal } from './AgentProposal';
import { BashApproval } from './BashApproval';
import { EditApproval } from './EditApproval';
import { ExternalInquiry } from './ExternalInquiry';
import { PlanApproval } from './PlanApproval';
import { RetryRequest } from './RetryRequest';
import { UserQuestion } from './UserQuestion';
import type { PendingApproval } from '../state/approvalQueue';

export interface ApprovalModalProps {
  readonly availableRows?: number;
  readonly pending: PendingApproval | undefined;
}

export function ApprovalModal(
  props: ApprovalModalProps,
): React.JSX.Element | null {
  if (!props.pending) return null;
  const { payload, decide } = props.pending;
  const availableRows = props.availableRows;
  switch (payload.kind) {
    case 'bash':
      return (
        <BashApproval
          availableRows={availableRows}
          payload={payload.payload}
          onDecide={decide}
        />
      );
    case 'toolEdit':
      return (
        <EditApproval
          availableRows={availableRows}
          request={payload.payload}
          onDecide={decide}
        />
      );
    case 'planApproval':
      return (
        <PlanApproval
          availableRows={availableRows}
          payload={payload.payload}
          onDecide={decide}
        />
      );
    case 'proposal':
      return (
        <AgentProposal
          availableRows={availableRows}
          payload={payload.payload}
          onDecide={decide}
        />
      );
    case 'retry':
      return (
        <RetryRequest
          availableRows={availableRows}
          payload={payload.payload}
          onDecide={decide}
        />
      );
    case 'externalInquiry':
      return (
        <ExternalInquiry
          availableRows={availableRows}
          payload={payload.payload}
          onDecide={decide}
        />
      );
    case 'userQuestion':
      return (
        <UserQuestion
          availableRows={availableRows}
          payload={payload.payload}
          onDecide={decide}
        />
      );
  }
  return assertNever(payload, 'Unhandled approval payload');
}
