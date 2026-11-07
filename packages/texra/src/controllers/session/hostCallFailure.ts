/**
 * The one failure tag a GUI host's capability names (`hostFailure`), and
 * `fromHost`, which lifts a capability that still answers with a promise (a
 * VS Code command, an editor API, a Promise-faced controller port) at the
 * host edge rather than at the depth that calls it. A refusal the callee
 * already worded travels as itself; every other rejection is tagged with the
 * member it came from, so the bridge can tell a refusal from a defect.
 */
import { Effect } from 'effect';

import { isRequestRefusal, type RequestRefusal } from '@texra-ai/harness';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import { HostFailed } from '@texra/hosts/uiHosts';

/** How a host call's failure is worded, whatever shape it arrived in. */
export function hostFailure(
  member: string,
  cause: unknown,
): HostFailed | RequestRefusal {
  return isRequestRefusal(cause)
    ? cause
    : new HostFailed({ member, message: toErrorMessage(cause), cause });
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
