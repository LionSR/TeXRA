/**
 * How a runtime request fails (PRD one-fold-three-renderers, 7.6).
 * Yieldable `Data.TaggedError`s in the runtime; a bridge that parses
 * requests adds its `Invalid` arm and the wire shape with it (8.4). A request
 * naming a stream the runtime no longer has is `Unavailable`, never a
 * defect: with two surfaces on one session, one can act from a view that has
 * not yet folded the other's `stream.removed`, and a defect would bypass the
 * response path and leave the sender's latch pending forever.
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

/** A handler died. The cause is in the host log under `ref` (the request
 *  id); the surface hears that the request failed, never the text. */
export class Internal extends Data.TaggedError('Internal')<{
  readonly ref: string;
}> {}

export type RequestError = NotOwner | Unavailable | Rejected | Internal;
