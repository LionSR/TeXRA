import { randomUUID } from 'node:crypto';

import { summarizeSubagentFollowup } from '@shared/subagentFollowup';
import {
  type FollowUpContent,
  type FollowUpSender,
  type RunId,
  type RunRelation,
} from '@shared/schemas';
import { isInstruction } from '@shared/session/runFacts';
import type { WithBlobs } from '@shared/session/historyTurns';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { InboxItem } from './Inbox';

/** What the run was asked to do, joined from its instructing input. */
export function userFollowUpInstruction(
  followUps: readonly FollowUpContent[],
): string | undefined {
  const instruction = followUps
    .filter(isInstruction)
    .map((followUp) => followUp.text)
    .join('\n\n')
    .trim();
  return instruction || undefined;
}

/** The `followup.queued` row one send writes, with the blobs its media
 *  brings: its id is the delivery id when the producer gave one, a run
 *  sender gets its relation to the recipient, a child's delivery keeps its
 *  facts typed, a notice gets its envelope's summary as its `displayText`,
 *  and a host's notification waits for the turn's end. */
export function queuedRow(
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  relationOf: (sender: RunId) => RunRelation,
): WithBlobs<Omit<QueuedFollowUp, 'commit'>> {
  const { from: input, deliveryId, control } = item;
  const from: FollowUpSender =
    input.kind === 'run'
      ? { kind: 'run', runId: input.runId, relation: relationOf(input.runId) }
      : input;
  const holdUntil = hold ?? (from.kind === 'notification' ? 'turn' : undefined);
  const row = {
    followUpId: deliveryId ?? randomUUID(),
    ...(holdUntil ? { holdUntil } : {}),
    ...(control ? { control } : {}),
  };
  if ('delivery' in item)
    return { ...row, content: { delivery: item.delivery, from } };
  const { text, media, blobs } = item;
  // A notice shows its envelope's summary, decided once here; a person's own
  // message is shown as typed.
  const summary = from.kind === 'user' ? text : summarizeSubagentFollowup(text);
  const displayText =
    item.displayText ?? (summary === text ? undefined : summary);
  return {
    ...row,
    ...(blobs !== undefined && { blobs }),
    content: {
      text,
      ...(displayText !== undefined && { displayText }),
      ...(media !== undefined && { media: [...media] }),
      from,
    },
  };
}

/**
 * Who a producer says a follow-up is from. Runs talk as a graph: any run may
 * message any run in the project, whatever their places in the supervision
 * tree. A run names only itself; the recipient's admission
 * (`Inbox.send`) stamps how it relates to the recipient.
 */
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
