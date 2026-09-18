/**
 * How a runtime request fails (PRD one-fold-three-renderers, 7.6).
 * Yieldable `Data.TaggedError`s in the runtime; a bridge that parses
 * requests adds its `Invalid` arm and the wire shape with it (8.4). A request
 * naming a stream the runtime no longer has is `Unavailable`, never a
 * defect: with two surfaces on one session, one can act from a view that has
 * not yet folded the other's `run.removed`, and a defect would bypass the
 * response path and leave the sender's latch pending forever.
 */
import { Data } from 'effect';

import type { RunId } from '@shared/schemas';

/** Another live owner holds the run this request would act on. */
export class NotOwner extends Data.TaggedError('NotOwner')<{
  readonly runId: RunId;
}> {}

/** The stream, request, or run the request names is gone or not in a state
 *  that can take it. */
export class Unavailable extends Data.TaggedError('Unavailable')<{
  readonly runId: RunId;
  readonly reason: string;
}> {}

/** The user cancelled the operation. No refusal notice is needed. */
export class Cancelled extends Data.TaggedError('Cancelled') {}

/** The runtime refused the request for a worded reason. */
export class Rejected extends Data.TaggedError('Rejected')<{
  readonly reason: string;
  readonly docsCommand?: string;
}> {}

/** A handler died. The cause is in the host log under `ref` (the request
 *  id); the surface hears that the request failed, never the text. */
export class Internal extends Data.TaggedError('Internal')<{
  readonly ref: string;
}> {}

export type RequestError =
  NotOwner | Unavailable | Cancelled | Rejected | Internal;

/**
 * How a host's request handler fails (PRD one-fold-three-renderers, 8.3):
 * with a tagged error, always. Three tags are the refusals the bridge folds
 * onto the wire ({@link RequestRefusal}); every other tag is a defect it
 * logs and answers `Internal` — but it is a *named* defect, so the log says
 * which capability produced it. The bound is structural because the tags a
 * host raises are its own (its lifted capabilities, its preview host, its
 * housekeeping); what every host owes this channel is that each of them is
 * a tag, so a bare `new Error(...)` can no longer reach the fold.
 */
export interface HostRequestFailure extends Error {
  readonly _tag: string;
}

/**
 * A request's refusal, as opposed to its defect: the three a handler may
 * answer the surface with. The bridge folds these onto the wire; every other
 * tag is `Internal`.
 */
export type RequestRefusal = Cancelled | Unavailable | Rejected;

/** Whether a failure is one of the three the bridge answers on the wire. */
export function isRequestRefusal(error: unknown): error is RequestRefusal {
  return (
    error instanceof Cancelled ||
    error instanceof Unavailable ||
    error instanceof Rejected
  );
}
