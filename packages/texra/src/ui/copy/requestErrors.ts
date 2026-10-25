/**
 * How a failed runtime request reads in every renderer: the progress view,
 * the desktop and the terminal print this one sentence for each error kind.
 */
import type { RequestError } from '@texra-ai/harness/schemas';

/** A failed request in words. */
export function requestErrorText(error: RequestError): string {
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
