/**
 * The one failure tag a GUI host's lifted capability names, and the lift that
 * names it (PRD one-fold-three-renderers, 8.3). Both hosts still reach
 * capabilities that answer with a promise — a VS Code command, an editor API,
 * a Promise-faced controller port, the desktop's preview and file hosts — and
 * each is lifted at the host edge rather than at the depth that calls it: a
 * refusal the callee already worded travels as itself, and every other
 * rejection is tagged with the member it came from, so the bridge's
 * refusal-versus-defect fold and its log read what `await` handed over.
 */
import { Data, Effect } from 'effect';

import {
  isRequestRefusal,
  type RequestRefusal,
} from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * A host capability failed on a channel the request has no tag for. `member`
 * names which one; `message` is the failure's own text and `cause` the value
 * it failed or rejected with, so a host that classifies a failure still
 * reads the capability's own error rather than this wrapper.
 */
export class HostCallFailed extends Data.TaggedError('HostCallFailed')<{
  readonly member: string;
  readonly message: string;
  readonly cause: unknown;
}> {}

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
