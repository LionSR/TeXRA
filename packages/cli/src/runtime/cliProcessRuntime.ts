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
 * one `CliSecrets` of this storage root — a value, because an Effect-typed
 * secret store runs nothing of its own — `SetupPlatform` over the CLI's
 * sign-in, and `AppState` over the global state store, opened as this
 * layer's own build step. Whichever entry arrives first therefore fixes both
 * stores, and `initCliPlatform` reads the state store back off the service
 * rather than opening a second view of the same file.
 */
import { Effect } from 'effect';

import { SupabaseClient } from '@auth/SupabaseClient';
import { openAppStateStore } from '@controllers/session/appStateStore';
import { installProcessRuntime } from '@controllers/session/sessionLayer';

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

/**
 * Install the process runtime, or join the one already installed, and hand
 * it back: every entry that awaits this holds the runtime it runs on in a
 * local and threads it on, so nothing below the entry looks it up again.
 */
export function installCliProcessRuntime(
  storageRoot?: string,
): Promise<ProcessRuntime> {
  const installed = tryProcessRuntime();
  if (installed) return Promise.resolve(installed);
  if (pending) return pending;
  const storage = createNodeStorageProvider({ storageRoot });
  pending = (async () => {
    const processStart = await nodeProcesses.selfIdentity();
    // The services below close over the runtime they are provided by: the
    // secret store and the setup sign-in run their programs on it, and none
    // of these thunks runs before the layer builds, after the install.
    const runtime: ProcessRuntime = installProcessRuntime({
      processStart,
      globalStorage: () => storage.getGlobalStoragePath(),
      updateCheckStorage: () => storage.getGlobalStoragePath(),
      secrets: Effect.succeed(getCliSecrets(storageRoot)),
      appState: Effect.orDie(openAppStateStore(storage.getGlobalStoragePath())),
      setup: {
        host: 'cli',
        signIn: async () => {
          await signInCliSupabase(runtime, { openBrowser: true });
          return SupabaseClient.isAuthenticated();
        },
      },
      lean: directLeanLanguageServices(),
    });
    return runtime;
  })().finally(() => {
    pending = null;
  });
  return pending;
}
