/** Formatting of canonical inquiry records for tools and the inquiry panel. */
import type {
  InquiryThreadRecord,
  InquiryTranscriptTurn,
} from '@shared/schemas';
import { unique } from '@utils/core';

export function inquiryRecordToTranscript(
  manifest: InquiryThreadRecord,
): InquiryTranscriptTurn[] {
  return manifest.turns.map((turn) => ({
    turnIndex: turn.turnIndex,
    timestamp: turn.timestamp,
    question: turn.question,
    context: turn.context ?? undefined,
    answer: turn.kind === 'answered' ? turn.answer : undefined,
    answeredAt: turn.kind === 'answered' ? turn.answeredAt : undefined,
    sessionLinks:
      turn.kind === 'answered' ? (turn.sessionLinks ?? undefined) : undefined,
  }));
}

/**
 * Collect distinct external session links (most-recent-first) across all
 * turns of a thread. Used by the inquiry panel to render "known external
 * session links" so the user can continue the same outside conversation.
 */
export function collectKnownSessionLinks(
  manifest: InquiryThreadRecord | null | undefined,
): string[] | undefined {
  if (!manifest) return undefined;

  const known = unique(
    manifest.turns
      .toReversed()
      .filter((turn) => turn.kind !== 'open')
      .flatMap((turn) => turn.sessionLinks ?? []),
  );

  return known.length ? known : undefined;
}
