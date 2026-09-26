/**
 * Who a follow-up is from: what admission stamps on each row. Runs talk as a
 * graph: any run may message any run in the project, whatever their places
 * in the supervision tree. Stamped inside the recipient's admission job
 * (`ToolUseFollowUpQueue.submitBatch`), so the parentage it reads is
 * committed state.
 */
import { randomUUID } from 'node:crypto';

import type { FollowUpContent, FollowUpSender, RunId } from '@shared/schemas';
import { runRelation } from '@shared/session/runRelation';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { FollowUpQueueInput } from './ToolUseFollowUpQueueManager';

/** Who a producer says it is: a run names itself, and admission stamps how
 *  it relates to the recipient. */
export type FollowUpSenderInput =
  | Exclude<FollowUpSender, { readonly kind: 'run' }>
  | { readonly kind: 'run'; readonly runId: RunId };

/** The sender a tool call speaks as: its run, or the user when no run
 *  calls it. */
export function senderOf(caller: RunId | undefined): FollowUpSenderInput {
  return caller === undefined
    ? { kind: 'user' }
    : { kind: 'run', runId: caller };
}

/** The row a producer's input becomes: a run sender's relation to the
 *  recipient is read from both runs' lineage. */
export function stampFollowUp(
  recipient: RunId,
  input: FollowUpQueueInput,
  lineage: { readonly parentOf: (runId: RunId) => RunId | null | undefined },
): QueuedFollowUp {
  const sender = input.from;
  const from: FollowUpContent['from'] =
    sender.kind === 'run'
      ? {
          kind: 'run',
          runId: sender.runId,
          relation: runRelation(sender.runId, recipient, lineage.parentOf),
        }
      : sender;
  return {
    followUpId: input.deliveryId ?? randomUUID(),
    content: {
      text: input.text,
      displayText: input.displayText,
      mediaFiles: input.mediaFiles ? [...input.mediaFiles] : undefined,
      from,
    },
  };
}
