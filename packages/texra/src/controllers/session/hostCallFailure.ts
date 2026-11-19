/**
 * The one failure tag a GUI host's capability names (`hostFailure`), and
 * `fromHost`, which lifts a capability that still answers with a promise (a
 * VS Code command, an editor API, a Promise-faced controller port) at the
 * host edge rather than at the depth that calls it. A refusal the callee
 * already worded travels as itself; every other rejection is tagged with the
 * member it came from, so the bridge can tell a refusal from a defect.
 * `openLink` is the one wording of a browser open that failed.
 */
import { Effect } from 'effect';

import {
  toErrorMessage,
  Cancelled,
  Rejected,
  Unavailable,
} from '@texra-ai/harness/schemas';
import { HostFailed, type ExternalOpener } from '@texra/hosts/uiHosts';

/**
 * How a host's request handler fails: with a tagged error, always. The three
 * {@link RequestRefusal}s reach the surface as themselves; every other tag
 * is a defect the bridge logs and answers `Internal`, but a named one, so
 * the log says which capability produced it. The bound is structural
 * because the tags a host raises are its own (its lifted capabilities, its
 * preview host, its housekeeping); what every host owes this channel is
 * that each is a tag, so a bare `new Error(...)` cannot reach the bridge.
 */
export interface HostCommandFailure extends Error {
  readonly _tag: string;
}

/** A request's refusal, as opposed to its defect: the three a handler may
 *  answer the surface with. */
export type RequestRefusal = Cancelled | Unavailable | Rejected;

/** Whether a failure is one of the three the bridge answers on the wire. */
export function isRequestRefusal(error: unknown): error is RequestRefusal {
  return (
    error instanceof Cancelled ||
    error instanceof Unavailable ||
    error instanceof Rejected
  );
}

/** A host member's failure in the cause's own words, for a member that
 *  raises no refusal. */
export function hostFailed(member: string, cause: unknown): HostFailed {
  return new HostFailed({ member, message: toErrorMessage(cause), cause });
}

/** How a host call's failure is worded, whatever shape it arrived in. */
export function hostFailure(
  member: string,
  cause: unknown,
): HostFailed | RequestRefusal {
  return isRequestRefusal(cause) ? cause : hostFailed(member, cause);
}

/** A host capability that still answers with a promise, lifted once and
 *  named through {@link hostFailure}. */
export function fromHost<A>(
  member: string,
  call: () => PromiseLike<A>,
): Effect.Effect<A, HostFailed | RequestRefusal> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => hostFailure(member, cause),
  });
}

/** A page in the browser through a host's `open`; one the host would not
 *  open is a rejection in the host's words, so the view shows which address
 *  did not open. */
export function openLink(
  open: ExternalOpener['openExternal'],
  url: string,
): Effect.Effect<void, Rejected> {
  return open(url).pipe(
    Effect.mapError((failed) => new Rejected({ reason: failed.message })),
  );
}
