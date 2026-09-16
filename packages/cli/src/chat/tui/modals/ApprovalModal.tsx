// Dispatches the head item of the approval queue to the right modal.
//
// The `pending` slot is passed in as a prop so the parent owns the single
// `useSignal(currentApproval)` subscription — avoids a second store read
// every render.

import type { SessionHandle } from '@agent/runtime';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { SurfaceDecision } from '@shared/session/approvalDecision';
import { assertNever } from '@utils/core';
import { AgentProposal } from './AgentProposal';
import { BashApproval } from './BashApproval';
import { EditApproval } from './EditApproval';
import { PlanApproval } from './PlanApproval';
import { RetryRequest } from './RetryRequest';
import { UserQuestion } from './UserQuestion';
import type { PendingApproval } from '../state/approvalQueue';

export interface ApprovalModalProps {
  readonly availableRows?: number;
  readonly goalAutoApproveAll: boolean;
  readonly pending: PendingApproval | undefined;
  /** The session the answered decision lands on, from the App that holds it. */
  readonly session: SessionHandle;
  /** The process runtime the answered decision is issued on, from the App
   *  that already holds it. */
  readonly runtime: ProcessRuntime;
}

export function ApprovalModal(
  props: ApprovalModalProps,
): React.JSX.Element | null {
  if (!props.pending) return null;
  const { payload, decide } = props.pending;
  const availableRows = props.availableRows;
  const onDecide = (decision: SurfaceDecision): void =>
    decide(props.session, props.runtime, decision);
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
          autoApproveAll={props.goalAutoApproveAll}
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
