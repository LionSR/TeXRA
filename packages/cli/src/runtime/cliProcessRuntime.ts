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
 * This module is the CLI's composition root for that runtime and holds it in
 * a local of its own (rulings ledger, #12720): there is no process-wide slot
 * to read it back from, and nothing below the entries looks one up. The
 * local is the runtime itself, never a boolean beside it -- a boolean goes
 * stale in both directions, true while `selfIdentity()` is still in flight
 * and still true after the disposal, which is how a caller after a platform
 * shutdown ends up selecting a disposed runtime. `disposeCliProcessRuntime`
 * is the one writer that clears it, after the disposal it performs, so the
 * next entry installs rather than joins. `pending` is not that latch: it is
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

import { SupabaseAuth } from '@auth/SupabaseAuth';
import { SignInFailed } from '@common/errors/signInFailed';
import { openAppStateStore } from '@controllers/session/appStateStore';
import {
  disposeProcessRuntime,
  installProcessRuntime,
} from '@controllers/session/sessionLayer';
import { AppState, type StateStore } from '@platform/interfaces';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import type { ProcessRuntime } from '@platform/processRuntime';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { getCliSecrets } from './cliSecrets';
import { setCliLogRuntime } from './logSinks';
import { cliAgentResume } from './cliAgentResume';
import { ensureCliSupabaseAuth, signInCliSupabase } from './supabaseAuth';

/** The process runtime and the global state store installed under it. */
export interface CliProcessRuntimeInstall {
  readonly runtime: ProcessRuntime;
  readonly globalState: StateStore;
}

interface CliProcessRuntimeInstallState {
  readonly runtime: ProcessRuntime;
  readonly globalState: StateStore | undefined;
}

/** This process's install, held by the module that performs it. */
let installed: CliProcessRuntimeInstallState | null = null;
let pending: Promise<CliProcessRuntimeInstallState> | null = null;

/**
 * Install the process runtime, or join the one already installed, and hand
 * it back with the global state store it serves: every entry that awaits
 * this holds both in locals and threads them on, so nothing below the entry
 * looks either up again.
 *
 * The store is read back off the joined runtime rather than off the install
 * record beside it: an already-installed runtime carries the store it serves
 * as `AppState` in its own context, so a join that finds an `AppState`-less
 * install (clone's) fails loudly there instead of handing back an absent
 * store.
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
  const current = installed?.runtime;
  if (current) {
    if (omitAppState) return Promise.resolve(current);
    return current
      .runPromise(AppState)
      .then((globalState) => ({ runtime: current, globalState }));
  }
  if (pending) {
    return omitAppState ? pending.then(({ runtime }) => runtime) : pending;
  }
  const storage = createNodeStorageProvider({ storageRoot });
  pending = (async () => {
    const processStart = await nodeProcesses.selfIdentity();
    // The records layers take the path as a value, so it resolves here, at
    // install. The default entry already pays the getter's `mkdirSync` opening
    // the state store below; clone's omit entry must not — its storage root
    // may be read-only and it runs no records operation — so it resolves the
    // same path with the pure calculator, as `initCliPlatform` does.
    const globalStoragePath = omitAppState
      ? resolveGlobalStoragePath(storageRoot ?? DEFAULT_NODE_STORAGE_ROOT)
      : storage.getGlobalStoragePath();
    // Both stores this entry provides exist before the runtime that serves
    // them. Opening the state store needs the filesystem and nothing else —
    // it provides its own database layer — so it runs here, on a bootstrap
    // fiber, rather than on a runtime that does not exist yet. Nothing in
    // the open path logs or traces through Effect, so running it off the
    // process runtime's diagnostics layer changes no output.
    const globalState = omitAppState
      ? undefined
      : await Effect.runPromise(
          openAppStateStore(globalStoragePath).pipe(
            Effect.provide(nodeFileServices),
          ),
        );
    const secrets = getCliSecrets(storageRoot);
    // The account plane is built beside the runtime that serves it; the CLI's
    // sign-in surfaces settle it through the auth run edge, which
    // `initializeCliSupabaseAuth` installs over this runtime.
    const auth = ensureCliSupabaseAuth(secrets);
    const runtime: ProcessRuntime = installProcessRuntime({
      processStart,
      globalStorage: globalStoragePath,
      updateCheckStorage: globalStoragePath,
      secrets,
      ...(globalState === undefined ? {} : { appState: globalState }),
      auth,
      // A terminal has no editor language models; the CLI's platform installs
      // the same port.
      languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
      // The one resume port, shared with the platform `initCliPlatform`
      // wires: it forwards to the chat TUI's handler whenever one is
      // mounted, whichever entry installed this runtime.
      agentResume: cliAgentResume,
      setup: {
        host: 'cli',
        // The one closure left over the runtime being installed, and a real
        // one: signing in runs a program on it, long after this returns.
        signIn: () =>
          Effect.tryPromise({
            try: async () => {
              await signInCliSupabase(runtime, { openBrowser: true });
              return runtime.runPromise(
                Effect.flatMap(SupabaseAuth, (plane) => plane.authenticated),
              );
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
    const record: CliProcessRuntimeInstallState = { runtime, globalState };
    installed = record;
    // The output plane runs its Effects on this runtime from here on; the
    // disposal below hands it back the no-runtime state.
    setCliLogRuntime(runtime);
    return record;
  })().finally(() => {
    pending = null;
  });
  return omitAppState ? pending.then(({ runtime }) => runtime) : pending;
}

/**
 * Dispose this process's install, if it made one: the CLI's own end of the
 * lifecycle this module owns the start of. The record is cleared after the
 * disposal settles, so a write racing the teardown still reaches the runtime
 * that is unwinding, and only if it is still this install -- one made while
 * this one unwound survives the clear that ends its predecessor.
 *
 * Registered by `initCliPlatform` as the last shutdown step and called
 * directly by the same root when a failed init must not leave the runtime
 * installed with nothing to dispose it.
 */
export function disposeCliProcessRuntime(): Promise<void> {
  const current = installed;
  if (!current) return Promise.resolve();
  return disposeProcessRuntime(current.runtime).finally(() => {
    if (installed !== current) return;
    installed = null;
    setCliLogRuntime(null);
  });
}
