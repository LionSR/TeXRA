// Dispatches the head item of the approval queue to the right modal.
//
// The `pending` slot is passed in as a prop so the parent owns the single
// `useSignal(currentApproval)` subscription — avoids a second store read
// every render.

import { AgentProposal } from './AgentProposal';
import { BashApproval } from './BashApproval';
import { EditApproval } from './EditApproval';
import { ExternalInquiry } from './ExternalInquiry';
import { PlanApproval } from './PlanApproval';
import { RetryRequest } from './RetryRequest';
import { UserQuestion } from './UserQuestion';
import { assertNever } from '../assertNever';
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
  switch (payload.kind) {
    case 'bash':
      return <BashApproval payload={payload.payload} onDecide={decide} />;
    case 'toolEdit':
      return (
        <EditApproval
          availableRows={props.availableRows}
          request={payload.request}
          onDecide={decide}
        />
      );
    case 'plan':
      return <PlanApproval payload={payload.payload} onDecide={decide} />;
    case 'proposal':
      return <AgentProposal payload={payload.payload} onDecide={decide} />;
    case 'retry':
      return <RetryRequest payload={payload.payload} onDecide={decide} />;
    case 'externalInquiry':
      return <ExternalInquiry payload={payload.payload} onDecide={decide} />;
    case 'userQuestion':
      return <UserQuestion payload={payload.payload} onDecide={decide} />;
  }
  return assertNever(payload, 'Unhandled approval payload');
}
