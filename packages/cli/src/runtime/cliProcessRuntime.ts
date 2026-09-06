/**
 * The CLI's install of the process Effect runtime (PRD 7.7).
 *
 * Three CLI entries need one, and any of them may be first: `initCliPlatform`,
 * which opens the state and config stores as Effect programs before it wires
 * the platform; `notifyCliUpdate`, which runs before any platform exists and
 * opens the global state store on its own; and `clone`, which never builds a
 * platform at all yet reads and writes its remote's token through
 * `CliSecrets`. Whichever arrives first builds the runtime and the rest run on
 * it, so a normal run still ends with exactly the runtime the platform's
 * shutdown disposes.
 *
 * Whether one is installed is asked of `@platform/processRuntime`, which owns
 * the reference, rather than tracked in a latch here: a boolean set beside the
 * install goes stale in both directions -- true while `selfIdentity()` is
 * still in flight, and still true after `disposeProcessRuntime` has cleared
 * the runtime, which is how a caller after a platform shutdown ends up
 * selecting a disposed one. `pending` is not that latch: it is the in-flight
 * install itself, so a second caller joins the first rather than racing it to
 * build a second runtime, and it is cleared once that install settles.
 *
 * The identity is the Node default `createNodePlatform` wires as
 * `platform().processes`, read before installing: the CLI's default session
 * opens through the synchronous `open`, which a pending identity would turn
 * into an asynchronous layer build.
 */
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { hasProcessRuntime } from '@platform/processRuntime';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';

let pending: Promise<void> | null = null;

export function installCliProcessRuntime(): Promise<void> {
  if (hasProcessRuntime()) return Promise.resolve();
  if (pending) return pending;
  pending = (async () => {
    installProcessRuntime(await nodeProcesses.selfIdentity());
  })().finally(() => {
    pending = null;
  });
  return pending;
}
