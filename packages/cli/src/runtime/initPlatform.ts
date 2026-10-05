// Third-party imports
import { Cause, Effect, Exit, Scope } from 'effect';

// Local imports
import {
  closeAllSessions,
  initializeDefaultSession,
  teardownDefaultSession,
  tryDefaultSession,
  type SessionHandle,
} from '@agent/runtime';
import {
  openProjectStateStore,
  openRepoStateStore,
} from '@controllers/session/appStateStore';
import { createTexraResponseTextProcessing } from '@latex/texraResponseTextProcessing';
import { setLogSink, silentLogSink } from '@logger/logSink';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import {
  AppState,
  type StateStore,
  type StateWriteFailed,
} from '@platform/interfaces';
import { Secrets, type PlatformSecrets } from '@platform/secrets';
import { DisposableStore } from '@platform/disposable';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@platform/processRuntime';
import { createNodeWorkspaceRoots } from '@platform/defaults/nodeHost';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { SessionOpenError } from '@shared/session/database';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { bootstrapHost } from '@texra/controllers/hostBootstrap';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';
import { ensureError } from '@utils/errors/errorMessage';

// Local file imports
import {
  disposeCliProcessRuntime,
  installCliProcessRuntime,
} from './cliProcessRuntime';
import {
  flushNdjsonStdout,
  flushTextStderr,
  writeTextStderr,
  writeTextStderrAndWait,
} from './logSinks';
import { CliExitCode } from './exitCodes';
import { terminalForegroundHeld } from './foregroundCommand';
import type { CliContext } from './cliContext';

type CliShutdownSignal = 'SIGINT' | 'SIGTERM';
// Removers for the listeners installCliShutdownSignalHandlers put on the
// process — kept so handOffCliShutdownSignalHandlers can remove exactly those
// (not every SIGINT/SIGTERM listener on the process) once an exclusive owner
// (the chat TUI) is about to install its own. Undefined means no platform
// handlers are currently installed.
let shutdownHandlers: DisposableStore | undefined;
// The one memoized open of the process session (`CliPlatformServices.session`),
// built by the first init beside the roots it installs; undefined only when
// another root opened the process session before this init ran (a test
// harness's fake host), in which case the session is that one.
let sessionOpen: Effect.Effect<SessionHandle, SessionOpenError> | undefined;
// The process's shutdown scope, made by the first init: its close is the
// CLI's shutdown, run once whichever exit path asks first (`shutdown`).
let shutdownScope: Scope.Closeable | undefined;
let shutdown: Effect.Effect<void> | undefined;

/** The CLI's shutdown: every session closes, then the project scope, then
 *  the process runtime. Nothing to do before a platform came up. */
export const cliPlatformShutdown: Effect.Effect<void> = Effect.suspend(
  () => shutdown ?? Effect.void,
);

type CliPlatformInitOptions = Pick<
  CliContext,
  | 'config'
  | 'cwd'
  | 'resourcesPath'
  | 'skillSourceOptions'
  | 'storageRoot'
  | 'version'
> & {
  readonly installSignalHandlers?: boolean;
  /** The caller shows `SessionHandle.storeMovedAside` itself: the chat TUI,
   *  in its transcript (`createChatSessionController`), since stderr written before Ink mounts is left
   *  above its header. Otherwise this init prints it to stderr: the
   *  platform's log sink is always silent. */
  readonly presentsStoreMovedAside?: boolean;
  /** The chat TUI: how its session follows interrupted tasks
   *  (`SessionHandleInit.interruptedTasks`). */
  readonly interruptedTasks?: 'offer' | 'retry';
};

/**
 * The platform services the CLI entry points read immediately after init.
 *
 * `initCliPlatform` already holds every one of them, from the runtime it
 * installed or joined and the roots it built (or an earlier init built), so
 * it hands them back instead of leaving each caller to look them up again.
 */
export type CliPlatformServices = SettingsStores & {
  /** The process's shutdown scope: a command that must act before the
   *  sessions close registers there, in a child scope of its own. */
  readonly shutdownScope: Scope.Scope;
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
   * `workspaceState`, `repoState` and `globalState` are the slots a catalog setting
   * resolves against, so a read or write through `readSettingFrom` /
   * `writeSettingTo` answers for this process's project, from the record
   * the caller holds rather than any process-wide lookup.
   */
  readonly secrets: PlatformSecrets;
  /**
   * The process roots this init installed: one process, one project (the
   * `--cwd` workspace) -- or, when another root opened the process session
   * before this init ran (a test harness's fake host), the roots that
   * session was opened over. A process with neither builds its own, so
   * every caller gets roots rather than branching on their absence.
   */
  readonly roots: WorkspaceRoots;
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

/**
 * The canonical "shut down the CLI platform" sequence — lifecycle shutdown
 * hooks, then the NDJSON stdout flush, then the runtime disposal that drains
 * the usage log — shared by every process.exit()-ing teardown path: the
 * headless signal handlers below AND the interactive chat TUI's own signal
 * handlers (see `handOffCliShutdownSignalHandlers`), which take over
 * SIGINT/SIGTERM exclusively once mounted and must perform the same sequence
 * the platform's own (now handed-off) handlers would have. One definition
 * means the two paths can't drift.
 *
 * A program, not a run: the caller runs it on the default runtime rather
 * than the process runtime, because the lifecycle shutdown below disposes the
 * process runtime (`disposeCliProcessRuntime`) before the flushes run, and a
 * teardown path must not depend on the thing it is tearing down.
 */
export function cliPlatformShutdownSequence(options: {
  /** The user's own `--quiet`, never a command's silenced log sink. */
  readonly quiet: boolean;
}): Effect.Effect<void> {
  // Each step is best effort, so a failure never stops termination, but it
  // is said, on stderr: the process runtime is gone by the flushes, and the
  // log sink is silent under the chat TUI (which has unmounted by now), so
  // only an explicit `--quiet` keeps it unsaid.
  const bestEffort = (step: string, effect: Effect.Effect<void>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        options.quiet
          ? Effect.void
          : writeTextStderrAndWait(
              `[warn] [cli.shutdown] ${step} failed: ${Cause.pretty(cause)}`,
            ),
      ),
    );
  return Effect.gen(function* () {
    // Signal shutdown is best effort; output still gets one final flush.
    yield* bestEffort('closing the platform', cliPlatformShutdown);
    // A closed stderr pipe must not prevent signal-based termination.
    yield* bestEffort('flushing stderr', flushTextStderr());
    // A closed stdout pipe must not prevent signal-based termination.
    yield* bestEffort('flushing stdout', flushNdjsonStdout());
  });
}

/**
 * The one run of an exit program: the CLI's two exit edges, the platform's
 * signal handlers above and the chat TUI's teardown, run theirs here, on the
 * default runtime, because `cliPlatformShutdownSequence` disposes the process
 * runtime a run on it would be standing on.
 */
export function runCliExit<E>(exit: Effect.Effect<void, E>): Promise<void> {
  return Effect.runPromise(exit);
}

export function installCliShutdownSignalHandlers(quiet: boolean): void {
  if (shutdownHandlers) return;
  const handlers = new DisposableStore();
  shutdownHandlers = handlers;

  const install = (signal: CliShutdownSignal, exitCode: number) => {
    const handler = async () => {
      // A foreground child (a pager, an installer) owns Ctrl-C while it
      // runs; its own listener records the interrupt, and
      // `runForegroundCommand` interrupts its command if the child died of
      // it. Re-arm so the next SIGINT reaches this handler again.
      if (signal === 'SIGINT' && terminalForegroundHeld()) {
        process.once(signal, handler);
        return;
      }
      await runCliExit(cliPlatformShutdownSequence({ quiet }));
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
 *  rather than building a second set. */
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
  context: CliPlatformInitOptions &
    Pick<CliContext, 'quietLogs' | 'minimumLogLevel'>,
): Effect.Effect<CliPlatformServices, Error> {
  return Effect.gen(function* () {
    // Every command renders its own output, so the platform's log lines go
    // nowhere; `quietLogs` is only the user's `--quiet`, which the shutdown
    // handler below reads.
    setLogSink(silentLogSink, { trusted: true });

    // The one Effect runtime of this process (PRD 7.7) comes first: the stores
    // below open as Effect programs, and the session graph and every
    // Promise-facing fiber run on it. Disposed after the default session has
    // released its graph. An entry that ran before any platform existed -- the
    // update check, `clone` -- may already have installed it, and every later
    // init finds it installed; each then adopts that one rather than building a
    // second and leaving the first undisposed.
    const runtime = yield* Effect.try({
      try: () =>
        installCliProcessRuntime(context.storageRoot, {
          resourcesPath: context.resourcesPath,
          minimumLogLevel: context.minimumLogLevel,
        }),
      catch: ensureError,
    });

    // One program on that runtime for the whole bootstrap: the process's global
    // state store comes from its own context, and on the first init everything
    // below runs in the same fiber rather than as a chain of separate runs.
    //
    // Double init is the normal path (every command runs this), so the roots
    // an earlier init installed (or, beside a test harness's fake host, the
    // process session it opened) are what the second and later calls find;
    // the first call builds them below.
    //
    // A step that fails after the runtime exists (a store that will not open, a
    // seed that will not write) registers nothing to dispose it; the failure
    // is re-raised so the caller reports the cause, and the process entry
    // (`bin/texra.ts`) disposes the still-installed runtime in its
    // `Effect.ensuring`, never a fiber on that runtime. Keep the roots and
    // lazy session private until the fallible setup has succeeded: their
    // ports have no reset operation.
    const { globalState, roots } = yield* withProcessServices(
      runtime,
      Effect.gen(function* () {
        const globalState = yield* AppState;
        // The three setting slots this process answers a catalog row from:
        // the roots an earlier init built, or -- when another root opened the
        // process session before this init ran (a test harness's fake host)
        // -- the roots that session was opened over, which is where `session`
        // below already looks.
        const joined = installedRoots ?? tryDefaultSession()?.roots;
        if (joined) return { globalState, roots: joined };

        const projectScope = yield* Scope.make();
        const closeProject = Scope.close(projectScope, Exit.void);
        return yield* Effect.gen(function* () {
          // The project's `texra.db` lives in its storage directory and is
          // owned by the project scope; AppState (global) is the runtime's.
          const { storageRoot } = context;
          const storage = resolveWorkspaceStoragePath(storageRoot, context.cwd);
          const workspaceState = yield* openProjectStateStore(
            storage,
            context.cwd,
          ).pipe(Scope.provide(projectScope));
          const repoState = yield* openRepoStateStore(context.cwd, storage);
          // One process, one project: the process roots are the `--cwd` workspace,
          // over the config provider the startup read already opened — the project
          // `.texra/config.json` layered over the user-level
          // `~/.texra/v1/global-storage/config.json`. One provider per process is
          // what keeps a value `texra config` writes readable at the next startup.
          const roots = createNodeWorkspaceRoots({
            host: 'cli',
            workspacePath: context.cwd,
            storage,
            globalStorage: resolveGlobalStoragePath(storageRoot),
            config: context.config,
            workspaceState,
            repoState,
            globalState,
          });
          // The one open of the process session, over the roots published below,
          // memoized so the first entry point that needs a session opens it and
          // every later one gets the same handle; an entry that needs none never
          // opens one.
          const openSession = yield* Effect.cached(
            Effect.acquireRelease(
              initializeDefaultSession({
                roots,
                responseTextProcessing: createTexraResponseTextProcessing(),
                ...(context.interruptedTasks !== undefined && {
                  interruptedTasks: context.interruptedTasks,
                }),
              }),
              () => teardownDefaultSession(),
            ).pipe(
              Scope.provide(projectScope),
              Effect.tap((session) =>
                Effect.sync(() => {
                  const moved = session.storeMovedAside;
                  if (moved && context.presentsStoreMovedAside !== true) {
                    writeTextStderr(sessionStoreMovedAsideMessage(moved));
                  }
                }),
              ),
            ),
          );

          // Everything this process installs once beside its roots, in the
          // order the shared bootstrap owns for all three hosts. Before the
          // roots are published below, not after: its one fallible step (the
          // first-install tool seed) must fail while they are still private,
          // as the seed did when this body owned it.
          yield* bootstrapHost({
            roots,
            skills: {
              resourcesPath: context.resourcesPath,
              skillSourceOptions: context.skillSourceOptions,
            },
          });

          // The one-time telemetry notice: a single stderr line, then a state
          // flag. A quiet run neither prints it nor marks it shown.
          if (!context.quietLogs) {
            const notice = yield* telemetryNoticeIfDue(roots.config);
            if (notice) writeTextStderr(notice);
          }

          // The shutdown is this scope's close, its finalizers run in the
          // reverse of their registration: every session closes first (its
          // runs stopped and settled, its artifacts flushed). That stops
          // agent-spawned OS children before the process exits, as the
          // extension and desktop hosts do: a background `bash` run is its own
          // process group (see execUtils), which its lifeline kills only once
          // `texra` is gone, and this close stops it first so its run settles.
          // Then the project scope with a final NDJSON flush, and the runtime
          // last, draining the usage log.
          const scope = Scope.makeUnsafe();
          yield* Scope.addFinalizer(scope, disposeCliProcessRuntime);
          yield* Scope.addFinalizer(
            scope,
            closeProject.pipe(Effect.ensuring(flushNdjsonStdout())),
          );
          yield* Scope.addFinalizer(scope, closeAllSessions());
          shutdownScope = scope;
          shutdown = yield* Effect.cached(Scope.close(scope, Exit.void));

          installedRoots = roots;
          sessionOpen = openSession;
          if (context.installSignalHandlers !== false) {
            installCliShutdownSignalHandlers(context.quietLogs);
          }
          return { globalState, roots };
        }).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? closeProject : Effect.void,
          ),
        );
      }),
    );

    // The stores this root opened, handed back rather than read off a
    // process-wide singleton: the secret store and the application state are
    // the ones the process runtime serves.
    const secrets = yield* withProcessServices(
      runtime,
      Effect.service(Secrets),
    );
    const cliServices: CliPlatformServices = {
      runtime,
      host: roots.host,
      config: roots.config,
      workspaceState: roots.workspaceState,
      repoState: roots.repoState,
      // The pure path calculator over this process's storage root (no mkdir),
      // so every CLI entry, including the ones that find the roots already
      // installed, names one root without touching the filesystem again.
      globalStorage: resolveGlobalStoragePath(context.storageRoot),
      globalState,
      secrets,
      session:
        sessionOpen ??
        Effect.suspend(() => {
          const opened = tryDefaultSession();
          return opened
            ? Effect.succeed(opened)
            : Effect.die(
                new Error(
                  'The CLI process session was opened by another root and is no longer open.',
                ),
              );
        }),
      // A platform joined over another root's session (a test harness's fake
      // host) has no CLI shutdown of its own to act before.
      shutdownScope: shutdownScope ?? Scope.makeUnsafe(),
      roots,
    };

    return cliServices;
  });
}
