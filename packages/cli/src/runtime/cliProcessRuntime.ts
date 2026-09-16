/**
 * The CLI's install of the process Effect runtime (PRD 7.7).
 *
 * Several CLI entries need one, and any of them may be first: `initCliPlatform`,
 * which opens the workspace state and config stores as Effect programs before
 * it wires the platform; `notifyCliUpdate`, which runs before any platform
 * exists; `clone`, which never builds a platform at all yet reads and writes
 * its remote's token through `CliSecrets`; and the headless run commands,
 * whose native validation runs before platform initialization. Whichever
 * arrives first builds the runtime and the rest run on it, so a normal run
 * still ends with exactly the runtime the platform's shutdown disposes.
 * Every entry but clone opens the global state store with the install, so
 * `AppState` answers from the first install on rather than only under
 * `initCliPlatform`; clone installs with `appState: 'omit'` (see the
 * function's docstring), so its runtime serves no `AppState` and its install
 * creates nothing under the storage root.
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
 * state store opened here, before the install (omitted by clone, the one
 * secrets-only entry), and `SetupPlatform` over the CLI's sign-in. The
 * global store is handed back with the runtime, so `initCliPlatform` opens
 * only the workspace scope and no entry has to discover a store some other
 * entry opened.
 */
import { Effect } from 'effect';

import { SupabaseClient } from '@auth/SupabaseClient';
import { openAppStateStore } from '@controllers/session/appStateStore';
import { installProcessRuntime } from '@controllers/session/sessionLayer';
import { SignInFailed } from '@common/errors/signInFailed';
import { AppState, type StateStore } from '@platform/interfaces';
import {
  tryProcessRuntime,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import { createNodeStorageProvider } from '@platform/defaults/nodeStorage';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getCliSecrets } from './cliSecrets';
import { signInCliSupabase } from './supabaseAuth';

/** The process runtime and the global state store installed under it. */
export interface CliProcessRuntimeInstall {
  readonly runtime: ProcessRuntime;
  readonly globalState: StateStore;
}

interface CliProcessRuntimeInstallState {
  readonly runtime: ProcessRuntime;
  readonly globalState: StateStore | undefined;
}

let pending: Promise<CliProcessRuntimeInstallState> | null = null;

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
 *
 * `appState: 'omit'` is `clone`'s: the one platform-less, secrets-only entry,
 * whose token can come from the environment and whose storage root may be
 * read-only. Opening the global state store creates the global storage
 * directory and its database, so clone installs the runtime without it and
 * serves no `AppState`. Nothing in a clone process joins the install after
 * it, which is what makes omitting safe: a default caller joining an
 * omit-installed runtime would fail the `AppState` read loudly, and a CLI
 * process runs exactly one command.
 */
export function installCliProcessRuntime(
  storageRoot?: string,
): Promise<CliProcessRuntimeInstall>;
export function installCliProcessRuntime(
  storageRoot: string | undefined,
  options: { readonly appState: 'omit' },
): Promise<ProcessRuntime>;
export function installCliProcessRuntime(
  storageRoot?: string,
  options?: { readonly appState: 'omit' },
): Promise<CliProcessRuntimeInstallState | ProcessRuntime> {
  const omitAppState = options?.appState === 'omit';
  const installed = tryProcessRuntime();
  if (installed) {
    if (omitAppState) return Promise.resolve(installed);
    return installed
      .runPromise(AppState)
      .then((globalState) => ({ runtime: installed, globalState }));
  }
  if (pending) {
    return omitAppState ? pending.then(({ runtime }) => runtime) : pending;
  }
  const storage = createNodeStorageProvider({ storageRoot });
  pending = (async () => {
    const processStart = await nodeProcesses.selfIdentity();
    // Both stores this entry provides exist before the runtime that serves
    // them. Opening the state store needs the filesystem and nothing else —
    // it provides its own database layer — so it runs here, on a bootstrap
    // fiber, rather than on a runtime that does not exist yet. Nothing in
    // the open path logs or traces through Effect, so running it off the
    // process runtime's diagnostics layer changes no output.
    const globalState = omitAppState
      ? undefined
      : await Effect.runPromise(
          openAppStateStore(storage.getGlobalStoragePath()).pipe(
            Effect.provide(nodeFileServices),
          ),
        );
    const runtime: ProcessRuntime = installProcessRuntime({
      processStart,
      globalStorage: () => storage.getGlobalStoragePath(),
      updateCheckStorage: () => storage.getGlobalStoragePath(),
      secrets: getCliSecrets(storageRoot),
      ...(globalState === undefined ? {} : { appState: globalState }),
      setup: {
        host: 'cli',
        // The one closure left over the runtime being installed, and a real
        // one: signing in runs a program on it, long after this returns.
        signIn: () =>
          Effect.tryPromise({
            try: async () => {
              await signInCliSupabase(runtime, { openBrowser: true });
              return SupabaseClient.isAuthenticated();
            },
            catch: (cause) =>
              new SignInFailed({
                message: `The CLI sign-in could not run: ${toErrorMessage(cause)}`,
                cause,
              }),
          }),
      },
      lean: directLeanLanguageServices(),
    });
    return { runtime, globalState };
  })().finally(() => {
    pending = null;
  });
  return omitAppState ? pending.then(({ runtime }) => runtime) : pending;
}
