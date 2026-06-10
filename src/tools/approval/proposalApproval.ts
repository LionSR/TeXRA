import { createStreamApprovalBypass } from './streamApprovalQueue';

/**
 * Per-stream bypass state for agent delegation proposals (super-YOLO).
 *
 * Proposals settle through the run coordinators rather than a stream approval
 * queue, so unlike bash / tool-edit there is no controller here — only the
 * shared bypass state bound to its progress event.
 */
export const proposalApprovalState = createStreamApprovalBypass(
  'updateSuperYoloBypassState',
);
