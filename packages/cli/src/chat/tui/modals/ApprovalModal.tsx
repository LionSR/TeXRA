// Renders one pending request with the modal its kind takes. The chat's
// approval queue and the attached-task view (`/tasks`) both use it, each
// with its own way of landing the decision.

import { absurd } from 'effect';
import type { ApprovalBypassKind } from '@texra-ai/harness/schemas';
import type { SurfaceDecision } from '@texra/shared/session/surfaceDecision';
import { AgentProposal } from './AgentProposal';
import { BashRequest } from './BashRequest';
import { ToolEditRequest } from './ToolEditRequest';
import { PlanRequest } from './PlanRequest';
import { RetryRequest } from './RetryRequest';
import { UserQuestion } from './UserQuestion';
import type { TuiRequest } from '../state/approvalQueue';

interface ApprovalModalProps {
  readonly availableRows?: number;
  readonly payload: TuiRequest;
  /** The run grant the request offers (`offeredGrant`): the one that
   *  answers it, none when a person answers it. */
  readonly grant: ApprovalBypassKind | null;
  /** Land the user's decision on the request. */
  readonly onDecide: (decision: SurfaceDecision) => void;
}

export function ApprovalModal(props: ApprovalModalProps): React.JSX.Element {
  const { payload, grant, onDecide, availableRows } = props;
  switch (payload.kind) {
    case 'bash':
      return (
        <BashRequest
          availableRows={availableRows}
          grant={grant}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
    case 'toolEdit':
      return (
        <ToolEditRequest
          availableRows={availableRows}
          grant={grant}
          payload={payload}
          onDecide={onDecide}
        />
      );
    case 'planApproval':
      return (
        <PlanRequest
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
    case 'proposal':
      return (
        <AgentProposal
          availableRows={availableRows}
          grant={grant}
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
    case 'userQuestion':
      return (
        <UserQuestion
          availableRows={availableRows}
          payload={payload.data}
          onDecide={onDecide}
        />
      );
  }
  return absurd(payload);
}
