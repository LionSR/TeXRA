/**
 * Cancellation causes that reach the agent verbatim as the feedback on a
 * dropped interaction. One event gets one explanation across every host, so a
 * model reading a transcript never has to reconcile host-specific wording.
 */

/** The session that owned the interaction was torn down. */
export const SESSION_DISPOSED_CAUSE = 'Session disposed.';

/** A newer request took the pending request's slot before the user answered. */
export const APPROVAL_REPLACED_CAUSE = 'Approval request was replaced.';
