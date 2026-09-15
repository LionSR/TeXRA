/**
 * The CLI's install of the process Effect runtime (PRD 7.7).
 *
 * Several CLI entries need one, and any of them may be first: `initCliPlatform`,
 * which opens the workspace state and config stores as Effect programs before
 * it wires the platform; `notifyCliUpdate`, which runs before any platform
 * exists; and `clone`, which never builds a platform at all yet reads and
 * writes its remote's token through `CliSecrets`; and the headless run
 * commands, whose native validation runs before platform initialization.
 * Whichever arrives first builds the runtime and the rest run on it, so a
 * normal run still ends with exactly the runtime the platform's shutdown
 * disposes. Whichever it is opens the global state store too, so `AppState`
 * answers from the first install on rather than only under
 * `initCliPlatform`.
 *
 * Whether one is installed is asked of `@platform/processRuntime`, which owns
 * the reference, rather than tracked in a latch here: a boolean set beside the
 * install goes stale in both directions -- true while `selfIdentity()` is
 * still in flight, and still true after `disposeProcessRuntime` has cleared
 * the runtime, which is how a caller after a platform shutdown ends up
 * selecting a disposed one. The same now holds for the store: it is read
 * back off the installed runtime rather than kept in a second module
 * variable that could disagree with it. `pending` is not that latch: it is
 * the in-flight install itself, so a second caller joins the first rather
 * than racing it to build a second runtime, and it is cleared once that
 * install settles.
 *
 * The process identity is read before installing, so the map's entries
 * never wait on it and `initCliPlatform`'s open of the default session is
 * the first thing built on the runtime.
 *
 * The process services every entry provides the same way, and every one of
 * them is a value this function already holds when it installs: `Secrets`
 * over the one `CliSecrets` of this storage root, `AppState` over the global
 * state store opened here, before the install, and `SetupPlatform` over the
 * CLI's sign-in. The global store is handed back with the runtime, so
 * `initCliPlatform` opens only the workspace scope and no entry has to
 * discover a store some other entry opened.
 */
import { Effect } from 'effect';

import { SupabaseClient } from '@auth/SupabaseClient';
import { openAppStateStore } from '@controllers/session/appStateStore';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { AppState, type StateStore } from '@platform/interfaces';
import {
  tryProcessRuntime,
  type ProcessRuntime,
} from '@platform/processRuntime';
import {
  nodeFileServices,
  type RunStateWrite,
} from '@platform/defaults/jsonStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';

import { getCliSecrets } from './cliSecrets';
import { signInCliSupabase } from './supabaseAuth';

/** The process runtime and the global state store installed under it. */
export interface CliProcessRuntimeInstall {
  readonly runtime: ProcessRuntime;
  readonly globalState: StateStore;
}

let pending: Promise<CliProcessRuntimeInstall> | null = null;

/**
 * Install the process runtime, or join the one already installed, and hand
 * it back with the global state store it serves: every entry that awaits
 * this holds both in locals and threads them on, so nothing below the entry
 * looks either up again.
 *
 * Whether one is installed is still asked of `@platform/processRuntime`, and
 * so is the store: an already-installed runtime carries the store it serves
 * as `AppState` in its own context, so joining reads it from there rather
 * than from a module latch that a second root (the test kernel's) would have
 * to remember to fill.
 */
export function installCliProcessRuntime(
  storageRoot?: string,
): Promise<CliProcessRuntimeInstall> {
  const installed = tryProcessRuntime();
  if (installed) {
    return installed
      .runPromise(AppState)
      .then((globalState) => ({ runtime: installed, globalState }));
  }
  if (pending) return pending;
  const storage = createNodeStorageProvider({ storageRoot });
  pending = (async () => {
    const processStart = await nodeProcesses.selfIdentity();
    // The Promise face of `StateStore.update`, run on the runtime installed
    // below: the store holds this and calls it only when something writes,
    // which is after that install.
    const runWrite: RunStateWrite = (write) => runtime.runPromise(write);
    // Both stores this entry provides exist before the runtime that serves
    // them. Opening the state store needs the filesystem and nothing else —
    // it provides its own database layer — so it runs here, on a bootstrap
    // fiber, rather than on a runtime that does not exist yet. Nothing in
    // the open path logs or traces through Effect, so running it off the
    // process runtime's diagnostics layer changes no output.
    const globalState = await Effect.runPromise(
      openAppStateStore(storage.getGlobalStoragePath(), runWrite).pipe(
        Effect.provide(nodeFileServices),
      ),
    );
    const runtime: ProcessRuntime = installProcessRuntime({
      processStart,
      globalStorage: () => storage.getGlobalStoragePath(),
      updateCheckStorage: () => storage.getGlobalStoragePath(),
      secrets: getCliSecrets(storageRoot),
      appState: globalState,
      setup: {
        host: 'cli',
        // The one closure left over the runtime being installed, and a real
        // one: signing in runs a program on it, long after this returns.
        signIn: async () => {
          await signInCliSupabase(runtime, { openBrowser: true });
          return SupabaseClient.isAuthenticated();
        },
      },
      lean: directLeanLanguageServices(),
    });
    return { runtime, globalState };
  })().finally(() => {
    pending = null;
  });
  return pending;
}
