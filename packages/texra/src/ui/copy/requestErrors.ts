/**
 * How a failed runtime request reads in every renderer: the progress view,
 * the desktop and the terminal print this one sentence for each error kind.
 */
import type { RequestErrorWire } from '@texra/shared/session/sessionFrames';

/** A failed request in words. A tagged `RequestError` has the same fields as
 *  its wire shape, so either one can be passed. */
export function requestErrorText(error: RequestErrorWire): string {
  switch (error._tag) {
    case 'Cancelled':
      return 'The request was cancelled.';
    case 'NotOwner':
      return 'Another TeXRA window or process controls this task.';
    case 'Unavailable':
    case 'Rejected':
    case 'Invalid':
      return error.reason;
    case 'Internal':
      return `The request failed inside TeXRA (reference ${error.ref}); see the TeXRA log.`;
  }
}
