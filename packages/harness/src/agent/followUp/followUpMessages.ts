import { randomUUID } from 'node:crypto';

import type { FollowUpContent } from '@shared/schemas';
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
 *  brings: its id is the delivery id when the producer gave one, a child's
 *  delivery keeps its facts typed, a message keeps the `displayText` its
 *  producer gave and the skills its user activated, and a host's
 *  notification waits for the turn's end. */
export function queuedRow(
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  skills?: readonly string[],
): WithBlobs<Omit<QueuedFollowUp, 'commit'>> {
  const { from, deliveryId, control } = item;
  const holdUntil = hold ?? (from.kind === 'notification' ? 'turn' : undefined);
  const row = {
    followUpId: deliveryId ?? randomUUID(),
    ...(holdUntil ? { holdUntil } : {}),
    ...(control ? { control } : {}),
  };
  if ('delivery' in item)
    return { ...row, content: { delivery: item.delivery, from } };
  const { text, displayText, media, blobs } = item;
  return {
    ...row,
    ...(blobs !== undefined && { blobs }),
    content: {
      text,
      ...(displayText !== undefined && { displayText }),
      ...(media !== undefined && { media: [...media] }),
      ...(skills !== undefined && { skills: [...skills] }),
      from,
    },
  };
}
