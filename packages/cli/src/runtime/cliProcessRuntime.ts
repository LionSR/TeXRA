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
 * Every entry but the two platform-less ones opens the global state store and
 * the global root's database with the install, so `AppState` and the
 * application records answer from the first install on rather than only under
 * `initCliPlatform`; `clone` and `install-github-action` hand over
 * {@link NO_PLATFORM_INSTALL} instead (see its docstring), so their install
 * creates nothing under the storage root and a read or write of either there
 * is loud.
 *
 * This module is the CLI's composition root for that runtime, and every
 * entry that awaits it holds the result in a local and threads it on: there
 * is no process-wide runtime slot for anything below an entry to read it
 * back from (rulings ledger, #12720). Whether one is installed is asked of
 * the session owner `installProcessRuntime` installs beside it, which
 * carries the runtime it runs on, rather than tracked in a latch here: a
 * boolean set beside the install goes stale in both directions -- true while
 * `selfIdentity()` is still in flight, and still true after the disposal,
 * which is how a caller after a platform shutdown ends up selecting a
 * disposed runtime. `pending` is not that latch: it is the in-flight install
 * itself, so a second caller joins the first rather than racing it to build
 * a second runtime, and it is cleared once that install settles.
 *
 * The process identity is read before installing, so the map's entries
 * never wait on it and `initCliPlatform`'s open of the default session is
 * the first thing built on the runtime.
 *
 * AppState is built from the runtime's GlobalDatabase layer, sharing its
 * scoped connection. Platform-less entries provide refusing services instead.
 * initCliPlatform reads that AppState and opens only the workspace scope.
 */
import { Effect, Layer } from 'effect';

import { installedProcessRuntime } from '@agent/runtime';
import { AgentDirectoryService } from '@agent/index';
import { SignInFailed } from '@common/errors/signInFailed';
import { appStateStoreFromDatabase } from '@controllers/session/appStateStore';
import { globalDatabaseLayer } from '@controllers/session/Database';
import {
  disposeProcessRuntime,
  installProcessRuntime,
} from '@controllers/session/sessionLayer';
import type { MinimumLogLevel } from '@logger/effectDiagnostics';
import {
  AgentDirectories,
  AppState,
  StateWriteFailed,
  type StateStore,
} from '@platform/interfaces';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { UNAVAILABLE_LANGUAGE_MODEL_PORT } from '@platform/languageModel';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { nodeFileServices } from '@platform/defaults/jsonStore';
import { DEFAULT_NODE_STORAGE_ROOT } from '@platform/defaults/nodeStorage';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { GlobalDatabase } from '@shared/session/database';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { readCliVersion } from './cliContext';
import { getCliSecrets } from './cliSecrets';
import { setCliLogRuntime, writeTextStderr } from './logSinks';
import { cliAgentResume } from './cliAgentResume';
import { ensureCliSupabaseAuth, signInCliSupabase } from './supabaseAuth';

let pending: Promise<ProcessRuntime> | null = null;

const NO_PLATFORM_APP_STATE =
  'A platform-less TeXRA CLI entry serves no application state: it runs without a platform and its storage root may be read-only.';

/**
 * The `AppState` of the CLI entries that have none. `clone` and
 * `install-github-action` run before any platform and may hold a read-only
 * storage root, so opening the real store — which would create the global
 * storage directory and its database — is what they must not do. A write is a
 * tagged refusal the caller composes; a read is a defect, because a store that
 * answered with the caller's fallback would read as absent state rather than
 * as no store at all.
 */
const refusingStateStore: StateStore = Object.freeze({
  get: (key: string) =>
    Effect.die(new Error(`${NO_PLATFORM_APP_STATE} "${key}" cannot be read.`)),
  update: (key: string) =>
    Effect.fail(
      new StateWriteFailed({
        key,
        message: `${NO_PLATFORM_APP_STATE} "${key}" cannot be written.`,
        cause: undefined,
      }),
    ),
});

const NO_PLATFORM_GLOBAL_ROOT =
  'A platform-less TeXRA CLI entry reads and writes no global record: it runs without a platform and its storage root may be read-only.';

const refuseGlobalRecord = (operation: string) =>
  Effect.die(
    new Error(`${NO_PLATFORM_GLOBAL_ROOT} "${operation}" cannot run.`),
  );

/**
 * The `GlobalDatabase` of those same entries. Opening the real handle creates
 * the global storage directory and its SQLite file and forks that root's
 * 250 ms change poll for the life of the runtime; a platform-less entry may
 * hold a read-only storage root, runs no records operation, and installs a
 * runtime it disposes none of — an opened handle would also hold the event
 * loop open past that entry's own exit. Every member here is a defect rather
 * than a tagged failure, as a read of {@link refusingStateStore} is: no caller
 * in such a process composes one, so an answer of any other kind would read as
 * an empty global root rather than as no global root at all.
 */
const refusingGlobalDatabase: Layer.Layer<GlobalDatabase> = Layer.succeed(
  GlobalDatabase,
)({
  appendAll: () => refuseGlobalRecord('appendAll'),
  readAppStateKey: () => refuseGlobalRecord('readAppStateKey'),
  readInputHistory: () => refuseGlobalRecord('readInputHistory'),
  appendInputHistory: () => refuseGlobalRecord('appendInputHistory'),
  readDesktopProjects: () => refuseGlobalRecord('readDesktopProjects'),
  readUpdateCheck: () => refuseGlobalRecord('readUpdateCheck'),
  recordUpdateCheck: () => refuseGlobalRecord('recordUpdateCheck'),
  readInquiryRecord: () => refuseGlobalRecord('readInquiryRecord'),
  listInquiryRecords: () => refuseGlobalRecord('listInquiryRecords'),
  updateInquiryRecord: () => refuseGlobalRecord('updateInquiryRecord'),
});

/**
 * What an entry hands {@link installCliProcessRuntime} in place of the global
 * state store and the global root's database handle that install would
 * otherwise open for it.
 */
interface CliProcessRuntimeInstall {
  readonly appState?: StateStore;
  readonly globalDatabase?: Layer.Layer<GlobalDatabase>;
  /** The argv-selected diagnostics floor for this process runtime. */
  readonly minimumLogLevel?: MinimumLogLevel;
  /**
   * The packaged resources root the CLI's built-in agent directories resolve
   * against. Absent only for the platform-less entries, which load no agents.
   */
  readonly resourcesPath?: string;
}

/**
 * The install of the two CLI entries that bring no platform up: `clone`, the
 * secrets-only entry whose token can come from the environment and whose
 * storage root may be read-only, and `install-github-action`, which only
 * scaffolds a workflow file inside a git repository. Neither runs the platform
 * shutdown that disposes the runtime it installs, so neither may open the
 * global state store or the global root's database: the two refusals above
 * create nothing under the storage root and hold the event loop open past no
 * exit.
 *
 * Frozen, with its store frozen too: it crosses a module boundary and is read
 * once per command, so a caller that decorated `appState.get` would change how
 * every later platform-less run in the process refuses. `globalDatabase` is an
 * Effect `Layer`, an immutable descriptor this module does not own, so it is
 * left as Effect built it rather than frozen from here.
 */
export const NO_PLATFORM_INSTALL: CliProcessRuntimeInstall = Object.freeze({
  appState: refusingStateStore,
  globalDatabase: refusingGlobalDatabase,
});

/**
 * Install the process runtime, or join the one already installed: every entry
 * that awaits this holds it in a local and threads it on, so nothing below
 * the entry looks it up again.
 *
 * Only the runtime comes back. The global state store this install opens is
 * the `AppState` the runtime itself serves, so an entry that needs the store
 * reads it from context inside the program it is already running here —
 * there is no second record beside the runtime for a joining caller (or a
 * second root, like the test kernel's) to keep in sync.
 *
 * `options` is {@link NO_PLATFORM_INSTALL}, which the two platform-less
 * entries pass. Opening the global state store or the global root's database
 * creates the global storage directory and its SQLite file, so those entries
 * hand over the refusals above and this install opens nothing under that root.
 * Nothing in such a process joins the install after it, which is what makes
 * that safe: a default caller joining a refusing install reads the refusal
 * loudly, and a CLI process runs exactly one command.
 */
export function installCliProcessRuntime(
  storageRoot?: string,
  options?: CliProcessRuntimeInstall,
): Promise<ProcessRuntime> {
  const current = installedProcessRuntime();
  if (current) {
    // The output plane runs on whichever runtime this process ended up with,
    // installed here or found installed.
    setCliLogRuntime(current);
    return Promise.resolve(current);
  }
  if (pending) return pending;
  pending = (async () => {
    // Resolve process identity before installing. The runtime owns database
    // acquisition and the AppState layer built from its global handle.
    const { processStart, globalStoragePath } = await Effect.runPromise(
      Effect.gen(function* () {
        const processStart = yield* nodeProcesses.selfIdentity();
        // The global root resolves here, at install, with the pure
        // calculator: the directory is the state store's and the global
        // database's to create when they open below, and clone — whose
        // storage root may be read-only, and which runs no records
        // operation — must not create it at all.
        const globalStoragePath = resolveGlobalStoragePath(
          storageRoot ?? DEFAULT_NODE_STORAGE_ROOT,
        );
        return { processStart, globalStoragePath };
      }).pipe(Effect.provide(nodeFileServices)),
    );
    const version = await readCliVersion();
    const secrets = getCliSecrets(storageRoot);
    // The account plane is built beside the runtime that serves it.
    const auth = ensureCliSupabaseAuth(secrets);
    // The process lifecycle and agent directories are process services the
    // runtime serves, so both are built here, before the install, rather than
    // in the platform init that may join an already-installed runtime. The
    // built-in agent directories read straight out of the CLI package's
    // `dist/resources`; the platform-less entries pass no resources root and
    // load no agents.
    const lifecycle = createLifecycleHost({
      onError: (phase, error) => {
        writeTextStderr(
          `[error] [cli.lifecycle] Lifecycle ${phase} handler failed: ${toErrorMessage(error)}`,
        );
      },
    });
    const agentDirectories = new AgentDirectoryService({
      channel: 'cli',
      resourcesPath: options?.resourcesPath ?? '',
      customDirectoryStore: { get: () => Effect.succeed(undefined) },
    });
    const runtime: ProcessRuntime = installProcessRuntime({
      processStart: Effect.succeed(processStart),
      globalStorage: globalStoragePath,
      secrets,
      appState: options?.appState
        ? AppState.layer(options.appState)
        : Layer.effect(
            AppState,
            Effect.map(GlobalDatabase, (database) =>
              appStateStoreFromDatabase(globalStoragePath, database),
            ),
          ),
      auth,
      // A terminal has no editor language models; the CLI's platform installs
      // the same port.
      languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
      // The one resume port, shared with the platform `initCliPlatform`
      // wires: it forwards to the chat TUI's handler whenever one is
      // mounted, whichever entry installed this runtime.
      agentResume: cliAgentResume,
      agentDirectories: AgentDirectories.layer(agentDirectories),
      lifecycle,
      setup: {
        host: 'cli',
        // The one closure left over the runtime being installed, and a real
        // one: signing in runs a program on it, long after this returns. The
        // account plane it reports on is the one built above, which is also
        // the plane this runtime serves as `SupabaseAuth`.
        // The shared sign-in coordinator runs on the process services this
        // install builds, and the setup port hands back a service-free
        // program, so the services are provided from the runtime itself.
        signIn: () =>
          withProcessServices(
            runtime,
            signInCliSupabase(runtime, { openBrowser: true }).pipe(
              Effect.andThen(auth.authenticated),
            ),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new SignInFailed({
                  message: `The CLI sign-in could not run: ${toErrorMessage(cause)}`,
                  cause,
                }),
            ),
          ),
      },
      // CLI model traffic goes to the same Supabase usage log the extension
      // writes to, tagged with editorType 'cli' and the CLI version. The
      // runtime's disposal drains the queue, and that disposal is the last
      // shutdown step of every exit path this process has.
      usageLog: usageLogLayer({ version, editorType: 'cli' }),
      // The one handle on the global root, held for this runtime's life and
      // closed with it — or clone's refusal, which opens nothing.
      globalDatabase:
        options?.globalDatabase ?? globalDatabaseLayer(globalStoragePath),
      minimumLogLevel: options?.minimumLogLevel ?? 'Info',
    });
    // The output plane runs its Effects on this runtime from here on; the
    // disposal below hands it back the no-runtime state.
    setCliLogRuntime(runtime);
    return runtime;
  })().finally(() => {
    pending = null;
  });
  return pending;
}

/**
 * Dispose this process's runtime, if one is installed: the CLI's own end of
 * the lifecycle this module owns the start of, asked of the same owner the
 * install above joins. The output plane is handed back the no-runtime state
 * after the disposal settles, so a write racing the teardown still reaches
 * the runtime that is unwinding, exactly as it did before the shutdown began.
 *
 * Registered by `initCliPlatform` as the last shutdown step and called
 * directly by the same root when a failed init must not leave the runtime
 * installed with nothing to dispose it.
 */
export const disposeCliProcessRuntime: Effect.Effect<void> = Effect.suspend(
  () => {
    const runtime = installedProcessRuntime();
    if (!runtime) return Effect.void;
    return disposeProcessRuntime(runtime).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          setCliLogRuntime(null);
        }),
      ),
    );
  },
);
