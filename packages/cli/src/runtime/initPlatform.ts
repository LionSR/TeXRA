// Third-party imports
import { Cause, Data, Effect, Exit } from 'effect';

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
import { disposeProcessRuntime } from '@controllers/session/sessionLayer';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { consoleLogSink, setLogSink } from '@logger/logSink';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import {
  initProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import {
  type LifecycleHost,
  type StateStore,
  type StateWriteFailed,
} from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { DisposableStore } from '@platform/disposable';
import type { ProcessRuntime } from '@platform/processRuntime';
import { createLifecycleHost } from '@platform/defaults/lifecycleHost';
import { installLongRunningModelDispatcher } from '@platform/defaults/longRunningModelTransport';
import {
  createNodePlatform,
  createNodeWorkspaceRoots,
  initializeNodeRuntimeSkills,
} from '@platform/defaults/nodeHost';
import {
  createNodeStorageProvider,
  DEFAULT_NODE_STORAGE_ROOT,
} from '@platform/defaults/nodeStorage';
import { resolveGlobalStoragePath } from '@platform/defaults/workspaceStorage';
import { sessionStoreClearedMessage } from '@shared/copy/sessionStore';
import type { SessionOpenError } from '@shared/session/database';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { UsageLogService } from '@telemetry/UsageLogService';
import { registerRuntimeShutdownHandlers } from '@tools/agentCliSessionStores';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { initProcessSettingHost } from '@utils/config/platformSettings';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { installCliProcessRuntime } from './cliProcessRuntime';
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
export type CliPlatformServices = Pick<Platform, 'lifecycle'> & {
  /**
   * The one Effect runtime of this process, built (or joined) by this root:
   * every entry point runs its programs on it and threads it to the modules
   * that run programs at a Promise edge, instead of looking it up.
   */
  readonly runtime: ProcessRuntime;
  /** The process's cross-workspace storage root, from the roots built below. */
  readonly globalStorage: string;
  /** The stores this root opened, handed over rather than read back. */
  readonly globalState: StateStore;
  readonly secrets: PlatformSecrets;
  /**
   * The process roots this init installed: one process, one project (the
   * `--cwd` workspace). Undefined only when another root installed the
   * platform before this init ran (a test harness's fake host), so the
   * caller that needs them reports their absence rather than reading the
   * ambient roots.
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
 * `initInteractiveCliPlatform` and `handOffCliShutdownSignalHandlers`), which
 * take over SIGINT/SIGTERM exclusively once mounted and must perform the
 * same sequence the platform's own (now handed-off) handlers would have. One
 * definition means the two paths can't drift.
 *
 * Runs on the default runtime rather than the process runtime: the lifecycle
 * shutdown below disposes the process runtime (`disposeProcessRuntime`)
 * before the flushes run, and a teardown path must not depend on the thing
 * it is tearing down.
 */
/**
 * One teardown step faulted. Every step below is best effort — the sequence
 * ignores each failure so a stuck handler or a closed pipe cannot keep the
 * process alive — so this exists to name which step it was rather than to be
 * matched on.
 */
class CliShutdownStepFailed extends Data.TaggedError('CliShutdownStepFailed')<{
  readonly step: 'runShutdown' | 'flushTextStderr' | 'flushNdjsonStdout';
  readonly cause: unknown;
}> {}

export async function runCliPlatformShutdownSequence(
  lifecycle: LifecycleHost | undefined,
): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      // Signal shutdown is best effort; output still gets one final flush.
      yield* Effect.ignoreCause(
        Effect.tryPromise({
          try: () => lifecycle?.runShutdown() ?? Promise.resolve(),
          catch: (cause) =>
            new CliShutdownStepFailed({ step: 'runShutdown', cause }),
        }),
      );
      // A closed stderr pipe must not prevent signal-based termination.
      yield* Effect.ignoreCause(
        Effect.tryPromise({
          try: () => flushTextStderr(),
          catch: (cause) =>
            new CliShutdownStepFailed({ step: 'flushTextStderr', cause }),
        }),
      );
      // A closed stdout pipe must not prevent signal-based termination.
      yield* Effect.ignoreCause(
        Effect.tryPromise({
          try: () => flushNdjsonStdout(),
          catch: (cause) =>
            new CliShutdownStepFailed({ step: 'flushNdjsonStdout', cause }),
        }),
      );
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
 * `initInteractiveCliPlatform()` and this call (onboarding, model
 * resolution) still needs a graceful handler, so
 * the platform's stays live for that whole window instead of being
 * suppressed for the entire span up front.
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

/**
 * Init for commands that act on local state only (no model invocation):
 * inspect paths (history/agents/memory/multi-agent list+show) plus
 * local-destructive paths (history delete). Quiet logs and skip the
 * included-model-access probe, since no model is run.
 *
 * Not actually read-only — the name describes the boundary (local-only,
 * no provider calls), not safety. Destructive local operations belong here.
 */
export async function initLocalCliPlatform(
  context: CliPlatformInitOptions,
): Promise<CliPlatformServices> {
  return initCliPlatform({
    ...context,
    quietLogs: true,
  });
}

/**
 * Init for the REAL interactive entry points that hand control to the chat
 * TUI once the terminal-capability gate has already confirmed a usable TTY:
 * `texra chat` (including the bare `texra` default), `texra setup`, and
 * `texra resume`. All three eventually call
 * `runChatTui.tsx`'s `runChat()`, which installs its own SIGINT/SIGTERM/
 * SIGHUP handlers once Ink mounts and owns teardown (terminal-mode restore,
 * persistence drain, `runCliPlatformShutdownSequence`) from there.
 *
 * Unlike `initLocalCliPlatform`, this does *not* suppress the platform's own
 * signal handlers up front — every one of the three call sites still does
 * real async I/O (onboarding, model resolution)
 * between this call and the moment Ink actually mounts, and that window
 * needs a graceful handler just as much as a headless command does. The
 * platform handler stays installed through that window; `runChat()` calls
 * `handOffCliShutdownSignalHandlers()` immediately before installing its own
 * `process.on('SIGINT'/'SIGTERM', ...)` pair, at which point ownership
 * transfers exclusively and the two handler sets can never both be live.
 *
 * The type omits `installSignalHandlers` so a caller can't accidentally
 * suppress the platform handler early and reopen the pre-handoff gap this
 * function exists to close.
 */
export async function initInteractiveCliPlatform(
  context: Omit<CliPlatformInitOptions, 'installSignalHandlers'> &
    Pick<CliContext, 'quietLogs'>,
): Promise<CliPlatformServices> {
  return initCliPlatform(context);
}

/** The process roots the first init installed; later inits return them
 *  beside the already-installed platform. */
let installedRoots: WorkspaceRoots | undefined;

export async function initCliPlatform(
  context: CliPlatformInitOptions & Pick<CliContext, 'quietLogs'>,
): Promise<CliPlatformServices> {
  quietPlatformLogs = context.quietLogs;
  // The terminal is the operator's own, so entries reach it unredacted — the
  // contract `logSinks.ts` documents for CLI output.
  setLogSink(quietPlatformLogs ? { write: () => undefined } : consoleLogSink, {
    trusted: true,
  });

  // The one Effect runtime of this process (PRD 7.7) comes first: the stores
  // below open as Effect programs, and the session graph and every
  // Promise-facing fiber run on it. Disposed after the default session has
  // released its graph. An entry that ran before any platform existed -- the
  // update check, `clone` -- may already have installed it, and every later
  // init finds it installed; each then adopts that one rather than building a
  // second and leaving the first undisposed.
  const { runtime, globalState } = await installCliProcessRuntime(
    context.storageRoot,
  );

  // Double init is the normal path (every command calls one of these), so the
  // already-installed platform is the value returned on the second and later
  // calls; the first call keeps the one it builds below.
  let services = tryPlatform();
  if (!services) {
    installLongRunningModelDispatcher();
    // Everything below is the first init's own work on that runtime. A step
    // that fails after the runtime exists (a store that will not open, a
    // seed that will not write) must not leave the runtime installed with
    // nothing registered to dispose it: the failure disposes it and is
    // re-raised, so the caller reports the cause rather than a half-built
    // platform. Keep the platform, roots, and lazy session private until the
    // fallible setup has succeeded: their ports have no reset operation.
    const install = async () => {
      const stateStores = await runtime.runPromise(
        openCliWorkspaceState({
          storageRoot: context.storageRoot,
          workspacePath: context.cwd,
        }),
      );
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
      const platform = createNodePlatform({
        lifecycle,
        agentDirectories,
      });
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
      const openSession = runtime.runSync(
        Effect.cached(
          initializeDefaultSession({
            responseTextProcessing: createTexraResponseTextProcessing(
              createAgentResponseTextConnector(
                {
                  secrets: cliSecrets,
                  globalState,
                },
                roots,
              ),
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
        ),
      );

      // Seed first-install defaults (e.g. disabled tools). No-ops for anyone
      // whose DISABLED_TOOLS list already exists, so upgrading users keep the
      // tools they enabled.
      await runtime.runPromise(seedDisabledToolDefaults(globalState));

      // Kill agent-spawned OS children before the process dies, exactly as the
      // extension and desktop hosts do. Background `bash` runs are spawned
      // `detached` (their own process group, see execUtils) so they survive
      // `texra` exiting and can never deliver their follow-up result — without
      // this drain they are orphaned. Registered before the usage-log flush
      // below so the kills (all synchronous) land first, matching the other
      // hosts' ordering.
      registerRuntimeShutdownHandlers(lifecycle, {
        runSettlement: (settlement) => runtime.runPromise(settlement),
        // The session is opened lazily (`sessionOpen`); a process that never
        // asked for one has nothing to flush.
        flushArtifacts: async () => {
          const session = tryDefaultSession();
          if (session) await runtime.runPromise(session.settlePublications());
        },
        afterFlushArtifacts: [
          () => runtime.runPromise(UsageLogService.dispose()),
        ],
        afterRunSettlement: [
          () => runtime.runPromise(teardownDefaultSession()),
          () => flushNdjsonStdout(),
          () => disposeProcessRuntime(),
        ],
      });

      // Route CLI model traffic to the same Supabase usage log the extension
      // writes to, tagged with editorType 'cli' and the CLI version.
      // dispose() flushes any queued entries; it
      // runs on normal exit (bin/texra.ts finally) and on signals, both of
      // which call lifecycle.runShutdown().
      await runtime.runPromise(
        UsageLogService.initialize(runtime.scope, {}, context.version, 'cli'),
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
      return platform;
    };
    const initialized = await runtime.runPromiseExit(
      Effect.tryPromise({ try: install, catch: ensureError }),
    );
    if (Exit.isFailure(initialized)) {
      // The initialization fiber must exit before its owning runtime closes.
      await disposeProcessRuntime();
      throw Cause.squash(initialized.cause);
    }
    services = initialized.value;
  }

  // The stores this root opened, handed back rather than read off a
  // process-wide singleton: the secret store is the same stateless view over
  // this process's storage root the composition block installed, and the
  // application state is the store that install opened before it.
  const cliServices: CliPlatformServices = {
    runtime,
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
    initializeCliSupabaseAuth(runtime, cliServices.secrets, cliPlatformLog);
    supabaseAuthInitialized = true;
  }

  initializeNodeRuntimeSkills({
    resourcesPath: context.resourcesPath,
    skillSourceOptions: context.skillSourceOptions,
  });

  return cliServices;
}
