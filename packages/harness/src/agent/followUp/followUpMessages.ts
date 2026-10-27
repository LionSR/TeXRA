import { randomUUID } from 'node:crypto';

import {
  deliveryTagOf,
  SUMMARIZED_TAGS,
  formatScriptDeliverySummary,
  parseScriptDeliverySummary,
  summarizeSubagentFollowup,
} from '@shared/subagentFollowup';
import type {
  FollowUpContent,
  FollowUpSender,
  RunId,
  RunRelation,
  ScriptDeliverySummary,
} from '@shared/schemas';
import { isInstruction } from '@shared/session/runFacts';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { InboxItem } from './Inbox';

interface FollowUpDisplay {
  readonly text: string;
  /** Typed workflow delivery facts logged beside the collapsed row text. */
  readonly scriptSummary?: ScriptDeliverySummary;
}

/**
 * The text a follow-up shows in the transcript: its own display text, the
 * summary of a child's delivery, or the text it was sent with.
 */
export function followUpDisplay(followUp: FollowUpContent): FollowUpDisplay {
  if (followUp.displayText != null) {
    return { text: followUp.displayText };
  }
  const { from } = followUp;
  if (from.kind !== 'run' || from.relation !== 'child') {
    return { text: followUp.text };
  }
  // This is where a delivery envelope becomes a transcript row: parse the
  // workflow summary once here and carry it structured, so renderers never
  // re-extract it from the rendered text. Only the script envelopes own a
  // `<script-summary>` element — other tags' bodies are entity-escaped.
  const tag = deliveryTagOf(followUp.text);
  const scriptSummary =
    tag !== undefined && SUMMARIZED_TAGS.has(tag)
      ? parseScriptDeliverySummary(followUp.text)
      : undefined;
  if (scriptSummary) {
    return {
      text: formatScriptDeliverySummary(scriptSummary),
      scriptSummary,
    };
  }
  return { text: summarizeSubagentFollowup(followUp.text) };
}

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

/** The `followup.queued` row one send writes: its id is the delivery id
 *  when the producer gave one, and a run sender gets its relation to the
 *  recipient. */
export function queuedRow(
  item: InboxItem,
  hold: QueuedFollowUp['holdUntil'],
  relationOf: (sender: RunId) => RunRelation,
): QueuedFollowUp {
  const { from, deliveryId, mediaFiles, control, ...content } = item;
  return {
    followUpId: deliveryId ?? randomUUID(),
    ...(hold ? { holdUntil: hold } : {}),
    ...(control ? { control } : {}),
    content: {
      ...content,
      mediaFiles: mediaFiles?.slice(),
      from:
        from.kind === 'run'
          ? { kind: 'run', runId: from.runId, relation: relationOf(from.runId) }
          : from,
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
