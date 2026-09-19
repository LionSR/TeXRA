// Third-party imports
import { Effect } from 'effect';

// Local imports
import {
  createAgentResponseTextConnector,
  initializeDefaultSession,
  teardownDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import { createPlatformAgentDirectories } from '@agent/index';
import type { SupabaseSessionLog } from '@auth/SupabaseSession';
import { installTexraAccountProbes } from '@controllers/modelAccess/installTexraAccountProbes';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { consoleLogSink, setLogSink } from '@logger/logSink';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import {
  initProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import {
  AppState,
  type LifecycleHost,
  type StateStore,
  type StateWriteFailed,
} from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { DisposableStore } from '@platform/disposable';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { installLongRunningModelDispatcher } from '@platform/defaults/longRunningModelTransport';
import {
  createNodeWorkspaceRoots,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { sessionStoreClearedMessage } from '@shared/copy/sessionStore';
import type { SessionOpenError } from '@shared/session/database';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import {
  initProcessSettingHost,
  processSettingsStores,
} from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import {
  disposeCliProcessRuntime,
  installCliProcessRuntime,
} from './cliProcessRuntime';
import { getCliSecrets } from './cliSecrets';
import {
  flushNdjsonStdout,
  flushTextStderr,
  writeTextStderr,
} from './logSinks';
import { initializeCliSupabaseAuth } from './supabaseAuth';
import { openCliWorkspaceState } from './cliStateStores';
import { CliExitCode } from './exitCodes';
import type { CliContext } from './cliContext';

let supabaseAuthInitialized = false;
let quietPlatformLogs = false;
type CliShutdownSignal = 'SIGINT' | 'SIGTERM';
// Removers for the listeners installCliShutdownSignalHandlers put on the
// process — kept so handOffCliShutdownSignalHandlers can remove exactly those
// (not every SIGINT/SIGTERM listener on the process) once an exclusive owner
// (the chat TUI) is about to install its own. Undefined means no platform
// handlers are currently installed.
let shutdownHandlers: DisposableStore | undefined;
// The one memoized open of the process session (`CliPlatformServices.session`),
// built by the first init beside the roots it installs; undefined only when
// another root installed the platform before this init ran (a test harness's
// fake host), in which case the session is whichever one that root opened.
let sessionOpen: Effect.Effect<SessionHandle, SessionOpenError> | undefined;

type CliPlatformInitOptions = Pick<
  CliContext,
  'config' | 'cwd' | 'resourcesPath' | 'skillSourceOptions' | 'version'
> & {
  readonly installSignalHandlers?: boolean;
  readonly storageRoot?: string;
};

/**
 * The platform services the CLI entry points read immediately after init.
 *
 * `initCliPlatform` already holds the whole `Platform` it just built (or the
 * one an earlier init installed), so it hands these capabilities back instead of
 * leaving each caller to re-enter the ambient `platform()` singleton for a
 * value the composition root was holding all along.
 */
export type CliPlatformServices = Pick<Platform, 'lifecycle'> &
  SettingsStores & {
    /**
     * The one Effect runtime of this process, built (or joined) by this root:
     * every entry point runs its programs on it and threads it to the modules
     * that run programs at a Promise edge, instead of looking it up.
     */
    readonly runtime: ProcessRuntime;
    /** The process's cross-workspace storage root, from the roots built below. */
    readonly globalStorage: string;
    /**
     * The stores this root opened, handed over rather than read back. `config`,
     * `workspaceState` and `globalState` are the three slots a catalog setting
     * resolves against, so a read or write through `readSettingFrom` /
     * `writeSettingTo` answers for this process's project, from the record
     * the caller holds rather than any process-wide lookup.
     */
    readonly secrets: PlatformSecrets;
    /**
     * The process roots this init installed: one process, one project (the
     * `--cwd` workspace). Undefined only when another root installed the
     * platform before this init ran (a test harness's fake host), so the
     * caller that needs them reports their absence rather than falling back
     * to a process-wide lookup.
     */
    readonly roots?: WorkspaceRoots;
    /**
     * The process session over the process roots: one CLI process, one
     * project, one persistent session, opened by the first entry point that
     * runs this Effect (`chat`, `run`, `resume`, `history`) and
     * handed to every later one as the same handle. `auth`, `doctor`,
     * `models`, `skills`, `tools` and `init` never run it, so a storage root
     * nothing can write to fails a command only when it asks for a transcript.
     */
    readonly session: Effect.Effect<SessionHandle, SessionOpenError>;
  };

function logAt(
  level: 'debug' | 'info' | 'warn' | 'error',
  channel: string,
  message: string,
): void {
  if (quietPlatformLogs) return;
  writeTextStderr(`[${level}] [${channel}] ${message}`);
}

// A shutdown-handler failure is actionable degradation by the same rule, so it
// bypasses quietLogs too — every CLI command passes quietLogs:true, and routing
// this through logAt would make the cross-host parity below unreachable.
function showLifecycleError(message: string): void {
  writeTextStderr(`[error] [cli.lifecycle] ${message}`);
}

const cliPlatformLog: SupabaseSessionLog = {
  debug: (channel, message) => logAt('debug', channel, message),
  info: (channel, message) => logAt('info', channel, message),
  warn: (channel, message) => logAt('warn', channel, message),
  error: (channel, message) => logAt('error', channel, message),
};

/**
 * The canonical "shut down the CLI platform" sequence — lifecycle shutdown
 * hooks (notably `UsageLogService.dispose()`) then the NDJSON stdout flush —
 * shared by every process.exit()-ing teardown path: the headless signal
 * handlers below AND the interactive chat TUI's own signal handlers (see
 * `handOffCliShutdownSignalHandlers`), which take over SIGINT/SIGTERM
 * exclusively once mounted and must perform the same sequence the platform's
 * own (now handed-off) handlers would have. One definition means the two
 * paths can't drift.
 *
 * Runs on the default runtime rather than the process runtime: the lifecycle
 * shutdown below disposes the process runtime (`disposeCliProcessRuntime`)
 * before the flushes run, and a teardown path must not depend on the thing
 * it is tearing down.
 */
export async function runCliPlatformShutdownSequence(
  lifecycle: LifecycleHost | undefined,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Signal shutdown is best effort; output still gets one final flush.
      yield* Effect.ignoreCause(lifecycle?.runShutdown ?? Effect.void);
      // A closed stderr pipe must not prevent signal-based termination.
      yield* Effect.ignoreCause(flushTextStderr());
      // A closed stdout pipe must not prevent signal-based termination.
      yield* Effect.ignoreCause(flushNdjsonStdout());
    }),
  );
}

export function installCliShutdownSignalHandlers(
  lifecycle: LifecycleHost,
): void {
  if (shutdownHandlers) return;
  const handlers = new DisposableStore();
  shutdownHandlers = handlers;

  const install = (signal: CliShutdownSignal, exitCode: number) => {
    const handler = async () => {
      await runCliPlatformShutdownSequence(lifecycle);
      process.exit(exitCode);
    };
    process.once(signal, handler);
    handlers.add(() => process.removeListener(signal, handler));
  };

  install('SIGINT', CliExitCode.Interrupted);
  install('SIGTERM', CliExitCode.Terminated);
}

/**
 * Hands exclusive SIGINT/SIGTERM ownership from the platform's own handlers
 * (installed by `installCliShutdownSignalHandlers` above) to a caller that is
 * about to install its own — the chat TUI, immediately before it calls
 * `process.on('SIGINT'/'SIGTERM', ...)` once Ink mounts. Removes exactly the
 * listeners this module installed (tracked in `shutdownHandlers`), not every
 * SIGINT/SIGTERM listener on the process, and clears that store so a later
 * `initCliPlatform` first-init could reinstall if the platform is ever torn
 * down and reinitialized.
 *
 * Call this right at the handoff point, not any earlier: everything between
 * the interactive entry's `initCliPlatform` and this call (onboarding, model
 * resolution) still needs a graceful handler, so the platform's stays live
 * for that whole window instead of being suppressed for the entire span up
 * front.
 *
 * A no-op if the platform handlers were never installed (e.g. a headless
 * `initCliPlatform` call with `installSignalHandlers: false`, or a second
 * call after an earlier handoff already ran).
 */
export function handOffCliShutdownSignalHandlers(): void {
  shutdownHandlers?.dispose();
  shutdownHandlers = undefined;
}

/**
 * Record the model the chat is running as the default helper model. Returns
 * the write as the Effect it is: the callers that want a promise face own a
 * runtime and run it, and the ones that are already inside a program compose
 * it directly, so no runtime is threaded in here purely to keep the promise.
 */
export function setCliHelperModel(
  state: StateStore,
  model: string | undefined,
): Effect.Effect<void, StateWriteFailed> {
  // Keep the write lazy: a refused write is the caller's failure to handle,
  // not a rejection nobody reads.
  return model ? state.update(GlobalStateKey.HELPER_MODEL, model) : Effect.void;
}

/** The process roots the first init installed; later inits return them
 *  beside the already-installed platform. */
let installedRoots: WorkspaceRoots | undefined;

/**
 * Bring the CLI platform up, as the program it is: every entry runs it on
 * the process runtime it installed or joined (`installCliProcessRuntime`), so
 * the init and the work it feeds settle on one fiber instead of a Promise the
 * init resolves and a second run over the result.
 *
 * `installSignalHandlers` (default true) is the one behavioural choice here.
 * The headless commands leave it at the default and keep the platform's
 * SIGINT/SIGTERM pair for the whole command. The interactive entries — `texra
 * chat` (including the bare `texra` default), `texra setup` and `texra
 * resume` — also leave it at the default, deliberately: each still does real
 * work (onboarding, model resolution) between this call and the moment Ink
 * mounts, and that window needs a graceful handler just as much as a headless
 * command does. `runChat()` calls `handOffCliShutdownSignalHandlers()`
 * immediately before installing its own `process.on('SIGINT'/'SIGTERM', ...)`
 * pair, at which point ownership transfers exclusively and the two handler
 * sets can never both be live. Pass `false` only where no handler should be
 * installed at all (the TUI harness).
 */
export function initCliPlatform(
  context: CliPlatformInitOptions & Pick<CliContext, 'quietLogs'>,
): Effect.Effect<CliPlatformServices, Error> {
  return Effect.gen(function* () {
    quietPlatformLogs = context.quietLogs;
    // The terminal is the operator's own, so entries reach it unredacted — the
    // contract `logSinks.ts` documents for CLI output.
    setLogSink(
      quietPlatformLogs ? { write: () => undefined } : consoleLogSink,
      {
        trusted: true,
      },
    );

    // The one Effect runtime of this process (PRD 7.7) comes first: the stores
    // below open as Effect programs, and the session graph and every
    // Promise-facing fiber run on it. Disposed after the default session has
    // released its graph. An entry that ran before any platform existed -- the
    // update check, `clone` -- may already have installed it, and every later
    // init finds it installed; each then adopts that one rather than building a
    // second and leaving the first undisposed.
    const runtime = yield* Effect.tryPromise({
      try: () => installCliProcessRuntime(context.storageRoot),
      catch: ensureError,
    });

    // One program on that runtime for the whole bootstrap: the process's global
    // state store comes from its own context, and on the first init everything
    // below runs in the same fiber rather than as a chain of separate runs.
    //
    // Double init is the normal path (every command calls one of these), so the
    // already-installed platform is the value returned on the second and later
    // calls; the first call keeps the one it builds below.
    //
    // A step that fails after the runtime exists (a store that will not open, a
    // seed that will not write) must not leave the runtime installed with
    // nothing registered to dispose it: the failure disposes it and is
    // re-raised, so the caller reports the cause rather than a half-built
    // platform. Keep the platform, roots, and lazy session private until the
    // fallible setup has succeeded: their ports have no reset operation.
    const { globalState, platform: services } = yield* withProcessServices(
      runtime,
      Effect.gen(function* () {
        const globalState = yield* AppState;
        const installed = tryPlatform();
        if (installed) return { globalState, platform: installed };

        installLongRunningModelDispatcher();
        const stateStores = yield* openCliWorkspaceState({
          storageRoot: context.storageRoot,
          workspacePath: context.cwd,
        });
        // Same severity and wording as the extension/desktop hosts: a shutdown
        // handler failure is an error everywhere, not a warning in one host.
        const lifecycle = createLifecycleHost({
          onError: (phase, error) => {
            showLifecycleError(
              `Lifecycle ${phase} handler failed: ${toErrorMessage(error)}`,
            );
          },
        });
        const agentDirectories = createPlatformAgentDirectories({
          channel: 'cli',
          // Built-in agents are read straight out of the CLI package's shipped
          // `dist/resources`, never copied into the shared `~/.texra` root.
          resourcesPath: context.resourcesPath,
          customDirectoryStore: { get: () => undefined },
        });
        const cliSecrets = getCliSecrets(context.storageRoot);
        const platform: Platform = { lifecycle, agentDirectories };
        // One process, one project: the process roots are the `--cwd` workspace,
        // over the config provider the startup read already opened — the project
        // `.texra/config.json` (or the internal workspace store, when that file
        // cannot be read or its directory written) layered over the user-level
        // `~/.texra/v1/global-storage/config.json`. One provider per process is
        // what keeps a value `texra config` writes readable at the next startup.
        const roots = createNodeWorkspaceRoots({
          workspacePath: context.cwd,
          storage: stateStores.storage.getStoragePath(),
          globalStorage: stateStores.storage.getGlobalStoragePath(),
          config: context.config,
          workspaceState: stateStores.workspaceState,
          globalState,
        });
        // The one open of the process session, over the roots published below,
        // memoized so the first entry point that needs a session opens it and
        // every later one gets the same handle; an entry that needs none never
        // opens one. The latex text connector asks a helper model how to join
        // two strings; that model is resolved against the stores this root
        // opened.
        const openSession = yield* Effect.cached(
          initializeDefaultSession({
            responseTextProcessing: createTexraResponseTextProcessing(
              createAgentResponseTextConnector({
                ...roots,
                secrets: cliSecrets,
              }),
            ),
          }).pipe(
            Effect.tap((session) =>
              Effect.sync(() => {
                const cleared = session.storeCleared;
                if (cleared) {
                  writeTextStderr(sessionStoreClearedMessage(cleared));
                }
              }),
            ),
          ),
        );

        // Seed first-install defaults (e.g. disabled tools). No-ops for anyone
        // whose DISABLED_TOOLS list already exists, so upgrading users keep the
        // tools they enabled.
        yield* seedDisabledToolDefaults(globalState);

        // Kill agent-spawned OS children before the process dies, exactly as the
        // extension and desktop hosts do. Background `bash` runs are spawned
        // `detached` (their own process group, see execUtils) so they survive
        // `texra` exiting and can never deliver their follow-up result — without
        // this drain they are orphaned. Registered before the usage-log flush
        // below so the kills (all synchronous) land first, matching the other
        // hosts' ordering.
        registerRuntimeShutdownHandlers(lifecycle, {
          // The session is opened lazily (`sessionOpen`); a process that never
          // asked for one has nothing to flush.
          flushArtifacts: Effect.suspend(() => {
            const session = tryDefaultSession();
            return session ? session.settlePublications() : Effect.void;
          }),
          afterFlushArtifacts: [
            withProcessServices(runtime, UsageLogService.dispose()),
          ],
          afterRunSettlement: [
            teardownDefaultSession(),
            flushNdjsonStdout(),
            disposeCliProcessRuntime,
          ],
        });

        // Route CLI model traffic to the same Supabase usage log the extension
        // writes to, tagged with editorType 'cli' and the CLI version.
        // dispose() flushes any queued entries; it
        // runs on normal exit (bin/texra.ts finally) and on signals, both of
        // which run lifecycle.runShutdown.
        yield* UsageLogService.initialize(
          runtime.scope,
          {},
          context.version,
          'cli',
        );
        initPlatform(platform);
        initProcessWorkspaceRoots(roots);
        installedRoots = roots;
        sessionOpen = openSession;
        initProcessSettingHost('cli');
        // TeXRA's account plane (ChatGPT / Grok sign-in). Without
        // this the model layer is bring-your-own-key. See installTexraAccountProbes.
        installTexraAccountProbes(cliSecrets);
        if (context.installSignalHandlers !== false) {
          installCliShutdownSignalHandlers(lifecycle);
        }
        return { globalState, platform };
      }),
    ).pipe(Effect.onError(() => disposeCliProcessRuntime));

    // The stores this root opened, handed back rather than read off a
    // process-wide singleton: the secret store is the same stateless view over
    // this process's storage root the composition block installed, and the
    // application state is the store that install opened before it.
    // The three setting slots this process answers a catalog row from: the roots
    // this init installed when it built them, and otherwise the roots whichever
    // foreign root installed the platform published (a test harness's fake host)
    // — resolved once here through the funnel's own accessor, which is exactly
    // what each of these readers used to do for itself.
    const settingSlots = installedRoots ?? processSettingsStores();
    const cliServices: CliPlatformServices = {
      runtime,
      config: settingSlots.config,
      workspaceState: settingSlots.workspaceState,
      // The pure path calculator over this process's storage root (no mkdir),
      // so every CLI entry, including the ones that find the platform already
      // installed, names one root without touching the filesystem again.
      globalStorage: resolveGlobalStoragePath(
        context.storageRoot ?? DEFAULT_NODE_STORAGE_ROOT,
      ),
      globalState,
      secrets: getCliSecrets(context.storageRoot),
      session:
        sessionOpen ??
        Effect.suspend(() => {
          const opened = tryDefaultSession();
          return opened
            ? Effect.succeed(opened)
            : Effect.die(
                new Error(
                  'The CLI platform was installed by another root and no process session is open.',
                ),
              );
        }),
      lifecycle: services.lifecycle,
      roots: installedRoots,
    };

    if (!supabaseAuthInitialized) {
      initializeCliSupabaseAuth(cliServices.secrets, cliPlatformLog);
      supabaseAuthInitialized = true;
    }

    initializeNodeRuntimeSkills({
      resourcesPath: context.resourcesPath,
      skillSourceOptions: context.skillSourceOptions,
    });

    return cliServices;
  });
}
