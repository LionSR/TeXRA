import type { SessionEvent, SessionEventDraft } from '@shared/schemas';

/**
 * Refuse an inquiry update its thread's latest row does not admit. Returns
 * whether the update opens the thread (its first row, or a reopen of an
 * answered one), which is when it needs an owned open parent.
 */
export function validateInquiryTransition(
  previous: SessionEvent | undefined,
  draft: Extract<SessionEventDraft, { type: 'inquiryThreadUpdated' }>,
): boolean {
  if (previous === undefined) return true;
  if (previous.type !== 'inquiryThreadUpdated') {
    throw new Error(`Invalid inquiry history: ${draft.aggregateId}`);
  }
  const reopened = previous.status === 'answered' && draft.status === 'open';
  if (draft.turnCount < previous.turnCount) {
    throw new Error(
      `Inquiry update must preserve turn order: ${draft.threadId}`,
    );
  }
  if (reopened && draft.turnCount <= previous.turnCount) {
    throw new Error(`Inquiry reopen must advance the turn: ${draft.threadId}`);
  }
  if (previous.parentRunId !== draft.parentRunId && !reopened) {
    throw new Error(
      `Only an answered inquiry can change parents: ${draft.aggregateId}`,
    );
  }
  if (
    previous.status === 'open' &&
    draft.status === 'open' &&
    previous.turnCount !== draft.turnCount
  ) {
    throw new Error(
      `An open inquiry cannot start another turn: ${draft.aggregateId}`,
    );
  }
  if (previous.status === 'dropped' && draft.status !== 'dropped') {
    throw new Error(`A dropped inquiry cannot reopen: ${draft.aggregateId}`);
  }
  return reopened;
}
