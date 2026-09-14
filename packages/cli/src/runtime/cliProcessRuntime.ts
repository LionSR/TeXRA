/**
 * The CLI's install of the process Effect runtime (PRD 7.7).
 *
 * Several CLI entries need one, and any of them may be first: `initCliPlatform`,
 * which opens the state and config stores as Effect programs before it wires
 * the platform; `notifyCliUpdate`, which runs before any platform exists and
 * opens the global state store on its own; and `clone`, which never builds a
 * platform at all yet reads and writes its remote's token through
 * `CliSecrets`; and the headless run commands, whose native validation runs
 * before platform initialization. Whichever arrives first builds the
 * runtime and the rest run on it, so a normal run still ends with exactly
 * the runtime the platform's shutdown disposes.
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
 * The process identity is read before installing, so the map's entries
 * never wait on it and `initCliPlatform`'s open of the default session is
 * the first thing built on the runtime.
 *
 * The process services every entry provides the same way: `Secrets` over the
 * one `CliSecrets` of this storage root, `SetupPlatform` over the CLI's
 * sign-in, and `AppState` over the global state store `initCliPlatform`
 * binds here once it has opened it. That binding exists because the store
 * opens on the runtime being installed, and because the entry that installs
 * the runtime may not be the one that opens the store; it goes with the
 * six-entry shape when the CLI gets its single composition root.
 */
import { SupabaseClient } from '@auth/SupabaseClient';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import type { StateStore } from '@platform/interfaces';
import {
  tryProcessRuntime,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

import { getCliSecrets } from './cliSecrets';
import { signInCliSupabase } from './supabaseAuth';

let pending: Promise<ProcessRuntime> | null = null;
let globalState: StateStore | undefined;

/**
 * Install the runtime if this entry is the first to arrive, and hand the
 * installed one back either way. Every CLI entry point takes its runtime from
 * this return value and keeps it in a local (or in the services bag
 * `initCliPlatform` returns); nothing below reads it back out of the process.
 */
export function installCliProcessRuntime(
  storageRoot?: string,
): Promise<ProcessRuntime> {
  const installed = tryProcessRuntime();
  if (installed) return Promise.resolve(installed);
  if (pending) return pending;
  const storage = createNodeStorageProvider({ storageRoot });
  pending = (async () => {
    // The runtime this install builds, in this root's own local. The three
    // thunks below run per operation, and the layer they belong to is built
    // at the runtime's first run, so none of them can be reached before the
    // assignment two statements down -- which is the same reason
    // `installProcessRuntime` takes `secrets` and `appState` as thunks at
    // all. `built` names that local, so the secret store and the setup
    // sign-in run their programs on the runtime this root holds rather than
    // reading one back off the process.
    const root: { current?: ProcessRuntime } = {};
    const built = (): ProcessRuntime => {
      if (!root.current) {
        throw new Error(
          'The CLI process runtime is still being installed: its services are reachable only once installCliProcessRuntime has resolved.',
        );
      }
      return root.current;
    };
    const processStart = await nodeProcesses.selfIdentity();
    root.current = installProcessRuntime({
      processStart,
      globalStorage: () => storage.getGlobalStoragePath(),
      updateCheckStorage: () => storage.getGlobalStoragePath(),
      secrets: () => getCliSecrets(built(), storageRoot),
      appState: () => cliGlobalState(),
      setup: {
        host: 'cli',
        signIn: async () => {
          await signInCliSupabase({ runtime: built(), openBrowser: true });
          return SupabaseClient.isAuthenticated();
        },
      },
      lean: directLeanLanguageServices(),
    });
    return root.current;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * Bind the global state store `initCliPlatform` opened as this process's
 * `AppState`. Called once, right after the store opens; a service read before
 * that throws rather than reading a default.
 *
 * This is the one interim of its kind, and it exists only because of the
 * first-arrival latch above: `notifyCliUpdate` and `clone` install the
 * runtime before `initCliPlatform` runs, so a thunk handed in at install
 * time would belong to the wrong entry. It goes with the latch when the CLI
 * gets its single composition root (injection plan §6 step 2), where the
 * store is a local of that root and is threaded like every other host's.
 * Until then: exactly one binder, no second `bind*` beside it, and no other
 * process service registered this way.
 */
export function bindCliGlobalState(store: StateStore): void {
  globalState = store;
}

/**
 * The store {@link bindCliGlobalState} bound, for the composition root's own
 * services bag and for the `AppState` thunk above. A read before the bind
 * throws rather than reading a default.
 */
export function cliGlobalState(): StateStore {
  if (!globalState) {
    throw new Error(
      'CLI global state is not open: initCliPlatform() has not bound its store to the process runtime yet.',
    );
  }
  return globalState;
}
