import { Effect } from 'effect';

import { ensureError } from './errorMessage';

/**
 * Run a promise as a typed `Error` failure. The thrown error's identity is
 * preserved (its `code` included) rather than re-normalized, so callers can
 * inspect it as the Node error it is.
 */
export const fsCall = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: thunk, catch: ensureError });
