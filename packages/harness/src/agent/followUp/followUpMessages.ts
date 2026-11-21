import { randomUUID } from 'node:crypto';

import type { FollowUpContent } from '@shared/schemas';
import { isInstruction } from '@shared/session/runFacts';
import type { WithBlobs } from '@shared/session/historyTurns';
import type { QueuedFollowUp } from '@shared/session/runRows';
import { escapeText } from '@shared/utils/xmlEscape';
import { formatLocalTime } from '@utils/text/stringUtils';
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
): WithBlobs<Omit<QueuedFollowUp, 'commit' | 'at'>> {
  const { from, deliveryId } = item;
  const holdUntil = hold ?? (from.kind === 'notification' ? 'turn' : undefined);
  const row = {
    followUpId: deliveryId ?? randomUUID(),
    ...(holdUntil ? { holdUntil } : {}),
  };
  if ('delivery' in item)
    return { ...row, content: { delivery: item.delivery, from } };
  if ('control' in item)
    return { ...row, content: { control: item.control, from } };
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

/** A wake note: what a run wrote to itself for a later time (the `wake`
 *  tool), as its queued row holds it. Times are epoch milliseconds. */
export interface WakeNote {
  /** The row's `followUpId`: what a cancel names. */
  readonly id: string;
  readonly note: string;
  /** When the run asked for it: the row's commit time. */
  readonly asked: number;
  readonly due: number;
}

/** The wake note `row` is, if it is one: a message the run sent itself
 *  (`from.kind: 'self'`), the one kind of row that holds a time. */
export const wakeNoteOf = ({
  followUpId,
  at,
  content,
}: QueuedFollowUp): WakeNote | undefined =>
  'text' in content && content.from.kind === 'self'
    ? { id: followUpId, note: content.text, asked: at, due: content.from.due }
    : undefined;

/** The wake notes among a run's pending input, in the order it asked. */
export const wakeNotes = (rows: readonly QueuedFollowUp[]): WakeNote[] =>
  rows.flatMap((row) => wakeNoteOf(row) ?? []);

/**
 * A wake note as its run's model reads it, rendered where the row becomes
 * the run's message: it says the run wrote the note itself, when it asked,
 * when the note was due and when it is delivered (`now`), which is later
 * than due when no process held the run then. Without the frame the model
 * would read the note as a person's message.
 */
export const wakeNoteText = (
  { note, asked, due }: Omit<WakeNote, 'id'>,
  now: number,
): string =>
  [
    `<wake-note asked="${formatLocalTime(asked)}" due="${formatLocalTime(due)}" delivered="${formatLocalTime(now)}">`,
    'You wrote this note to yourself when you arranged to be continued at the due time. No person sent it: read it as your own reminder and decide what to do now.',
    '',
    escapeText(note),
    '</wake-note>',
  ].join('\n');
