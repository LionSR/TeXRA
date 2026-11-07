/**
 * The one failure tag a GUI host's capability names (`hostFailure`), and
 * `fromHost`, which lifts a capability that still answers with a promise (a
 * VS Code command, an editor API, a Promise-faced controller port) at the
 * host edge rather than at the depth that calls it. A refusal the callee
 * already worded travels as itself; every other rejection is tagged with the
 * member it came from, so the bridge can tell a refusal from a defect.
 */
import { Effect, Schema } from 'effect';

import { Cancelled, Conflict, Rejected, Unavailable } from '@texra-ai/harness';
import { toErrorMessage } from '@texra-ai/harness/schemas';

/**
 * How a host's request handler fails: with a tagged error, always. The four
 * {@link RequestRefusal}s reach the surface as themselves; every other tag
 * is a defect the bridge logs and answers `Internal`, but a named one, so
 * the log says which capability produced it. The bound is structural
 * because the tags a host raises are its own (its lifted capabilities, its
 * preview host, its housekeeping); what every host owes this channel is
 * that each is a tag, so a bare `new Error(...)` cannot reach the bridge.
 */
export interface HostRequestFailure extends Error {
  readonly _tag: string;
}

/** A request's refusal, as opposed to its defect: the four a handler may
 *  answer the surface with. */
export type RequestRefusal = Cancelled | Unavailable | Rejected | Conflict;

/** Whether a failure is one of the four the bridge answers on the wire. */
export function isRequestRefusal(error: unknown): error is RequestRefusal {
  return (
    error instanceof Cancelled ||
    error instanceof Unavailable ||
    error instanceof Rejected ||
    error instanceof Conflict
  );
}

/**
 * A host capability failed on a channel the request has no tag for. `member`
 * names which one; `message` is the failure's own text and `cause` the value
 * it failed or rejected with, so a host that classifies a failure still
 * reads the capability's own error rather than this wrapper.
 */
export class HostCallFailed extends Schema.TaggedError<HostCallFailed>()(
  'HostCallFailed',
  {
    member: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** How a host call's failure is worded, whatever shape it arrived in. */
export function hostFailure(
  member: string,
  cause: unknown,
): HostCallFailed | RequestRefusal {
  return isRequestRefusal(cause)
    ? cause
    : new HostCallFailed({ member, message: toErrorMessage(cause), cause });
}

/** A host capability that still answers with a promise, lifted once and
 *  named through {@link hostFailure}. */
export function fromHost<A>(
  member: string,
  call: () => PromiseLike<A>,
): Effect.Effect<A, HostCallFailed | RequestRefusal> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => hostFailure(member, cause),
  });
}
