/**
 * Who a producer says a follow-up is from. Runs talk as a graph: any run may
 * message any run in the project, whatever their places in the supervision
 * tree. A run names only itself; the recipient's admission
 * (`ToolUseFollowUpQueue`) stamps how it relates to the recipient.
 */
import type { FollowUpSender, RunId } from '@shared/schemas';

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
