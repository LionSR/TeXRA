/**
 * The CLI's install of the process Effect runtime (PRD 7.7).
 *
 * Several CLI entries need one, and any of them may be first: `initCliPlatform`,
 * which opens the workspace state and config stores as Effect programs before
 * it wires the platform; `notifyCliUpdate`, which runs before any platform
 * exists; `clone`, which never builds a platform at all yet reads and writes
 * its remote's token through `FileSecrets`; and the headless run commands,
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
 * entry that calls the install holds the result in a local and threads it
 * on: nothing below an entry reads it back (rulings ledger, #12720). The
 * one slot is this module's own: set with the runtime it built and cleared
 * as its disposal starts, so a caller after a platform shutdown builds a
 * fresh runtime rather than selecting a disposed one.
 *
 * The process identity is read as the runtime's own layer, over the
 * spawner that runtime serves, and `initCliPlatform`'s open of the default
 * session is the first thing built on it.
 *
 * AppState is built from the runtime's GlobalDatabase layer, sharing its
 * scoped connection. Platform-less entries provide refusing services instead.
 * initCliPlatform reads that AppState and opens only the workspace scope.
 */
import { Effect, Layer, ManagedRuntime, Stream } from 'effect';

import {
  AgentDirectories,
  AppState,
  processLayer,
  StateWriteFailed,
  type ProcessRuntime,
  type StateStore,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
  withForkFailureReporting,
} from '@texra-ai/harness';
import { resolveGlobalStoragePath } from '@texra-ai/harness/node';
import { AgentDirectoryService } from '@agent/index';
import { appStateStoreFromDatabase } from '@controllers/session/appStateStore';
import type { MinimumLogLevel } from '@logger/effectDiagnostics';
import { GlobalDatabase } from '@shared/session/database';
import { usageLogLayer } from '@telemetry/UsageLogService';
import { TEXRA_SETTING_ROWS } from '@texra/shared/settingsView/texraSettings';
import { texraPlugins } from '@texra/tools/registry';
import { USER_MCP_CONFIG_PATH } from '@tools/mcp/mcpConfig';

import { readCliVersion } from './cliContext';
import { cliSecrets } from './cliSecrets';
import { setCliLogRuntime } from './logSinks';

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
const refuseWrite = (key: string) =>
  Effect.fail(
    new StateWriteFailed({
      key,
      message: `${NO_PLATFORM_APP_STATE} "${key}" cannot be written.`,
      cause: undefined,
    }),
  );
const refusingStateStore: StateStore = Object.freeze({
  get: (key: string) =>
    Effect.die(new Error(`${NO_PLATFORM_APP_STATE} "${key}" cannot be read.`)),
  update: refuseWrite,
  modify: refuseWrite,
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
  values: {
    get: () => refuseGlobalRecord('values.get'),
    modify: () => refuseGlobalRecord('values.modify'),
    list: () => refuseGlobalRecord('values.list'),
    changes: () => Stream.fromEffect(refuseGlobalRecord('values.changes')),
  },
  readInputHistory: () => refuseGlobalRecord('readInputHistory'),
  appendInputHistory: () => refuseGlobalRecord('appendInputHistory'),
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

/** The runtime this module built, until its disposal starts. */
let installed: ProcessRuntime | undefined;

/**
 * Install the process runtime, or join the one already installed: every entry
 * that calls this holds it in a local and threads it on, so nothing below
 * the entry looks it up again. The install is synchronous end to end (the
 * version it stamps on usage entries is a sync manifest read), so two callers
 * cannot race to build two runtimes.
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
  storageRoot: string,
  options?: CliProcessRuntimeInstall,
): ProcessRuntime {
  if (installed) return installed;
  // The global root resolves here, at install, with the pure calculator:
  // the directory is the state store's and the global database's to create
  // when they open below, and clone — whose storage root may be read-only,
  // and which runs no records operation — must not create it at all.
  const globalStoragePath = resolveGlobalStoragePath(storageRoot);
  const version = readCliVersion();
  const secrets = cliSecrets(storageRoot);
  // The agent directories are a process service the runtime serves, so
  // they are built here, before the install, rather than in the platform
  // init that may join an already-installed runtime. The built-in agent
  // directories read straight out of the CLI package's `dist/resources`;
  // the platform-less entries pass no resources root and load no agents.
  // The custom directory is the one the other hosts read, from the shared
  // application state this runtime serves.
  const agentDirectoriesLayer = Layer.effect(
    AgentDirectories,
    Effect.map(
      AppState,
      (state) =>
        new AgentDirectoryService({
          channel: 'cli',
          resourcesPath: options?.resourcesPath ?? '',
          state,
        }),
    ),
  );
  const runtime: ProcessRuntime = withForkFailureReporting(
    ManagedRuntime.make(
      processLayer({
        globalStorage: globalStoragePath,
        plugins: texraPlugins(),
        settings: TEXRA_SETTING_ROWS,
        mcpConfigPath: USER_MCP_CONFIG_PATH,
        secrets,
        appState: options?.appState
          ? AppState.layer(options.appState)
          : Layer.effect(
              AppState,
              Effect.map(GlobalDatabase, (database) =>
                appStateStoreFromDatabase(globalStoragePath, database.values),
              ),
            ),
        // A terminal has no editor language models; the CLI's platform installs
        // the same port.
        languageModel: UNAVAILABLE_LANGUAGE_MODEL_PORT,
        agentDirectories: agentDirectoriesLayer,
        // CLI model traffic goes to the same anonymous usage log the other hosts
        // write to, tagged with editorType 'cli' and the CLI version. The
        // runtime's disposal drains the queue, and that disposal is the last
        // shutdown step of every exit path this process has.
        usageLog: usageLogLayer({ version, editorType: 'cli' }),
        // Absent, the one handle on the global root, held for this runtime's
        // life and closed with it; clone's refusal opens nothing.
        ...(options?.globalDatabase && {
          globalDatabase: options.globalDatabase,
        }),
        minimumLogLevel: options?.minimumLogLevel ?? 'Info',
      }),
    ),
  );
  installed = runtime;
  // The output plane runs its Effects on this runtime from here on; the
  // disposal below hands it back the no-runtime state.
  setCliLogRuntime(runtime);
  return runtime;
}

/**
 * Dispose this process's runtime, if one is installed: the CLI's own end of
 * the lifecycle this module owns the start of: the runtime the install above
 * built. The output plane is handed back the no-runtime state
 * after the disposal settles, so a write racing the teardown still reaches
 * the runtime that is unwinding, exactly as it did before the shutdown began.
 *
 * Registered by `initCliPlatform` as the last shutdown step, and run by the
 * process entry (`bin/texra.ts`) for whatever runtime is still installed —
 * which is how a failed init's runtime goes. Never from a fiber on the
 * runtime being disposed: that disposal waits for the fiber asking for it,
 * and the process exits with its top-level await unsettled.
 */
export const disposeCliProcessRuntime: Effect.Effect<void> = Effect.suspend(
  () => {
    const runtime = installed;
    if (!runtime) return Effect.void;
    installed = undefined;
    return runtime.disposeEffect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          setCliLogRuntime(null);
        }),
      ),
    );
  },
);
