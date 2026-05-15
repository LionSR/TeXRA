// Dispatches the head item of the approval queue to the right modal.
// Phase 2 wires all six modal kinds; resolvers stay on the legacy event
// dispatch path (modal calls back through the queue's `decide` callback,
// which the runChatTui approval installer hooks into the original
// resolveBashPermission / setToolEditApprovalHandler / etc.).

import { AgentProposal } from './AgentProposal';
import { BashApproval } from './BashApproval';
import { EditApproval } from './EditApproval';
import { ExternalInquiry } from './ExternalInquiry';
import { PlanApproval } from './PlanApproval';
import { RetryRequest } from './RetryRequest';
import { currentApproval } from '../state/approvalQueue';
import { useSignal } from '../state/useSignal';

export function ApprovalModal(): React.JSX.Element | null {
  const pending = useSignal(currentApproval);
  if (!pending) return null;
  const { payload, decide } = pending;
  switch (payload.kind) {
    case 'bash':
      return <BashApproval payload={payload.payload} onDecide={decide} />;
    case 'toolEdit':
      return <EditApproval request={payload.request} onDecide={decide} />;
    case 'plan':
      return <PlanApproval payload={payload.payload} onDecide={decide} />;
    case 'proposal':
      return <AgentProposal payload={payload.payload} onDecide={decide} />;
    case 'retry':
      return <RetryRequest payload={payload.payload} onDecide={decide} />;
    case 'externalInquiry':
      return <ExternalInquiry payload={payload.payload} onDecide={decide} />;
  }
}
