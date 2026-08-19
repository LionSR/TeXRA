/**
 * Cancellation causes that reach the agent verbatim, separately from human
 * feedback on a dropped interaction. One event gets one explanation across
 * every host, so a model never has to reconcile host-specific wording.
 */

/** The session that owned the interaction was torn down. */
export const SESSION_DISPOSED_CAUSE = 'Session disposed.';

/** A newer request took the pending request's slot before the user answered. */
export const APPROVAL_REPLACED_CAUSE = 'Approval request was replaced.';

/** The user cleared a pending retry request from the stream toolbar. */
export const RETRY_REQUEST_CLEARED_CAUSE = 'Retry request cleared.';

/** Every stream was deleted, so no interaction has an owner left to answer it. */
export const ALL_STREAMS_DELETED_CAUSE = 'All streams deleted.';
