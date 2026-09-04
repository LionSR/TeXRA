/**
 * How a runtime request fails (PRD one-fold-three-renderers, 7.6 and 8.4).
 * Yieldable `Data.TaggedError`s in the runtime; on the wire the same tagged
 * plain objects under the Zod union in `runtimeRequest.ts`. A request naming
 * a stream the runtime no longer has is `Unavailable`, never a defect: with
 * two surfaces on one session, one can act from a view that has not yet
 * folded the other's `stream.removed`, and a defect would bypass the response
 * path and leave the sender's latch pending forever.
 */
import { Data } from 'effect';

import type { StreamTabId } from '@shared/schemas';

/** Another live owner holds the run this request would act on. */
export class NotOwner extends Data.TaggedError('NotOwner')<{
  readonly streamId: StreamTabId;
}> {}

/** The stream, request, or run the request names is gone or not in a state
 *  that can take it. */
export class Unavailable extends Data.TaggedError('Unavailable')<{
  readonly streamId: StreamTabId;
  readonly reason: string;
}> {}

/** The runtime refused the request for a worded reason. */
export class Rejected extends Data.TaggedError('Rejected')<{
  readonly reason: string;
}> {}

/** The request's arm failed to parse; answered under its own id. */
export class Invalid extends Data.TaggedError('Invalid')<{
  readonly issues: readonly string[];
}> {}

export type RequestError = NotOwner | Unavailable | Rejected | Invalid;
