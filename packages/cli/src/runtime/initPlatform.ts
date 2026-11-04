// Third-party imports
import { Cause, Effect, Exit, Scope } from 'effect';

// Local imports
import {
  Sessions,
  type WorkspaceRoots,
  type LocalSession,
  type SessionOpenError,
} from '@texra-ai/harness';
import {
  AppState,
  type StateStore,
  type StateWriteFailed,
  withProcessServices,
  StateStores,
} from '@texra-ai/harness/host';
import {
  createNodeWorkspaceRoots,
  resolveWorkspaceStoragePath,
  setLogSink,
} from '@texra-ai/harness/node';
import { ensureError, GlobalStateKey } from '@texra-ai/harness/schemas';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { recordFirstCompletedRun } from '@texra/controllers/onboarding/onboardingFunnel';
import { interruptedTasksOnOpen } from '@texra/controllers/session/interruptedTasksOnOpen';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';

// Local file imports
import {
  disposeCliProcessRuntime,
  installCliProcessRuntime,
  type CliProcessRuntime,
} from './cliProcessRuntime';
import {
  flushStdout,
  flushTextStderr,
  silentLogSink,
  writeTextStderr,
  writeTextStderrAndWait,
} from './logSinks';
import { CliExitCode } from './exitCodes';
import { holdSignals, type SignalPolicy } from './processSignals';
import type { CliContext } from './cliContext';
import type { SettingsStores } from '@texra-ai/harness/host';

// The user's own `--quiet`, set with `installed`: the shutdown sequence's
// warnings are the one thing the platform still says after its log sink.
let shutdownQuiet = false;
// What the first init installed, set in one assignment once its fallible
// setup has succeeded; later inits return it rather than building a second
// set. `session` is the one memoized open of the process session
// (`CliPlatformServices.session`). `shutdownScope`'s close is the CLI's
// shutdown, run once whichever exit path asks first (`shutdown`).
let installed:
  | {
      readonly roots: WorkspaceRoots;
      readonly session: Effect.Effect<LocalSession, SessionOpenError>;
      readonly shutdownScope: Scope.Closeable;
      readonly shutdown: Effect.Effect<void>;
    }
  | undefined;

/** The CLI's shutdown: every session closes, then the project scope, then
 *  the process runtime. Nothing to do before a platform came up. */
export const cliPlatformShutdown: Effect.Effect<void> = Effect.suspend(
  () => installed?.shutdown ?? Effect.void,
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
  /** The caller shows `LocalSession.storeMovedAside` itself: the chat TUI,
   *  in its transcript (`createChatSessionController`), since stderr written before Ink mounts is left
   *  above its header. Otherwise this init prints it to stderr: the
   *  platform's log sink is always silent. */
  readonly presentsStoreMovedAside?: boolean;
  /** The chat TUI: its session recovers interrupted tasks
   *  (`OpenOptions.host.interruptedTasks`) as the `resumeOnOpen` setting
   *  says, or, beside a resume of one task that resuming the others would
   *  race, only lists them. */
  readonly interruptedTasks?: 'setting' | 'list';
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
  readonly runtime: CliProcessRuntime;
  /**
   * The process roots this init installed: one process, one project (the
   * `--cwd` workspace), built by the first init and found by every later
   * one, so every caller gets roots rather than branching on their absence.
   */
  readonly roots: WorkspaceRoots;
  /**
   * The process session over the process roots: one CLI process, one
   * project, one persistent session, opened by the first entry point that
   * runs this Effect (`chat`, `run`, `resume`, `history`) and
   * handed to every later one as the same session. `auth`, `doctor`,
   * `models`, `skills`, `tools` and `init` never run it, so a storage root
   * nothing can write to fails a command only when it asks for a transcript.
   */
  readonly session: Effect.Effect<LocalSession, SessionOpenError>;
};

/**
 * The canonical "shut down the CLI platform" sequence: lifecycle shutdown
 * hooks and the runtime disposal that drains the usage log, then the stderr
 * and stdout flushes `process.exit` would otherwise cut short. `cliExit`
 * below runs it before `process.exit`, for the platform's own signal policy
 * and for the chat TUI's teardown alike, so the two paths cannot drift;
 * `bin/texra.ts`'s `ensuring` runs the same shutdown on the ordinary return
 * path, where the event loop drains the streams.
 *
 * A program, not a run: the caller runs it on the default runtime rather
 * than the process runtime, because the lifecycle shutdown below disposes the
 * process runtime (`disposeCliProcessRuntime`) before the flushes run, and a
 * teardown path must not depend on the thing it is tearing down.
 */
function cliPlatformShutdownSequence(): Effect.Effect<void> {
  // Each step is best effort, so a failure never stops termination, but it
  // is said, on stderr: the process runtime is gone by the flushes, and the
  // log sink is silent under the chat TUI (which has unmounted by now), so
  // only an explicit `--quiet` keeps it unsaid.
  const bestEffort = (step: string, effect: Effect.Effect<void>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        shutdownQuiet
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
    yield* bestEffort('flushing stdout', flushStdout());
  });
}

/**
 * The one run of an exit program: the platform's signal policy and the chat
 * TUI's teardown run theirs here, on the default runtime, because
 * `cliPlatformShutdownSequence` disposes the process runtime a run on it
 * would be standing on.
 */
export function runCliExit<A, E>(exit: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(exit);
}

/** A process already leaving: a further signal ends it at once with that
 *  signal's code. The terminal's own `exit` hook restores the tty. */
export const leaveAtOnce: Readonly<SignalPolicy> = Object.freeze({
  SIGINT: () => process.exit(CliExitCode.Interrupted),
  SIGTERM: () => process.exit(CliExitCode.Terminated),
  SIGHUP: () => process.exit(129),
});

/** The one exit of a CLI process that leaves on its own: the platform's
 *  shutdown sequence, then `process.exit(code)`. A program for `runCliExit`;
 *  the caller holds `leaveAtOnce` first so a second signal meanwhile is not
 *  Node's default death mid-flush. */
export function cliExit(code: number): Effect.Effect<never> {
  return cliPlatformShutdownSequence().pipe(
    Effect.andThen(Effect.sync(() => process.exit(code))),
  );
}

// The platform's own answer to SIGINT and SIGTERM: leave through `cliExit`
// with the signal's code. A holder above it (a foreground child's, the chat
// TUI's) answers instead while it holds.
const leaveOnSignal = (code: number) => (): void => {
  holdSignals(leaveAtOnce);
  void runCliExit(cliExit(code));
};
const platformSignalPolicy: Readonly<SignalPolicy> = Object.freeze({
  SIGINT: leaveOnSignal(CliExitCode.Interrupted),
  SIGTERM: leaveOnSignal(CliExitCode.Terminated),
});

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
 * Bring the CLI platform up, as the program it is: every entry runs it on
 * the process runtime it installed or joined (`installCliProcessRuntime`), so
 * the init and the work it feeds run on one fiber instead of a Promise the
 * init resolves and a second run over the result.
 *
 * `installSignalHandlers` (default true) is the one behavioural choice here:
 * the platform holds SIGINT and SIGTERM (`holdSignals`) for the whole
 * command, the interactive entries included, since onboarding and model
 * resolution run before Ink mounts and need a graceful exit as much as a
 * headless command does. The chat TUI holds its own policy above the
 * platform's once Ink mounts and releases it as it leaves, so the newest
 * holder answers and the two are never both live. Pass `false` only where no
 * handler should be installed at all (the TUI harness).
 */
export const initCliPlatform = Effect.fn('initCliPlatform')(function* (
  context: CliPlatformInitOptions &
    Pick<CliContext, 'quietLogs' | 'minimumLogLevel'>,
): Effect.fn.Return<CliPlatformServices, Error> {
  // Every command renders its own output, so the platform's log lines go
  // nowhere; `quietLogs` is only the user's `--quiet`, which the shutdown
  // handler below reads.
  setLogSink(silentLogSink, { trusted: true });

  // The one Effect runtime of this process comes first: the stores
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
        skillSourceOptions: context.skillSourceOptions,
        minimumLogLevel: context.minimumLogLevel,
        workspace: context.cwd,
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
  // A step that fails after the runtime exists (a store that will not open)
  // registers nothing to dispose it; the failure is re-raised so the caller
  // reports the cause, and the process entry (`bin/texra.ts`) disposes the
  // still-installed runtime in its `Effect.ensuring`, never a fiber on that
  // runtime. Keep the roots and lazy session private until the fallible
  // setup has succeeded: their ports have no reset operation.
  const { globalState, platform } = yield* withProcessServices(
    runtime,
    Effect.gen(function* () {
      const globalState = yield* AppState;
      // A later init finds the roots and session an earlier one built.
      if (installed) return { globalState, platform: installed };
      const sessions = yield* Sessions;

      const projectScope = yield* Scope.make();
      const closeProject = Scope.close(projectScope, Exit.void);
      return yield* Effect.gen(function* () {
        // The project's `texra.db` lives in its storage directory and is
        // owned by the project scope; AppState (global) is the runtime's.
        const { storageRoot } = context;
        const storage = resolveWorkspaceStoragePath(storageRoot, context.cwd);
        const workspaceState = yield* (yield* StateStores)
          .project(storage, context.cwd)
          .pipe(Scope.provide(projectScope));
        const repoState = yield* (yield* StateStores).repo(
          storage,
          context.cwd,
        );
        // One process, one project: the process roots are the `--cwd` workspace,
        // over the config provider the startup read already opened — the project
        // `.texra/config.json` layered over the user-level
        // `~/.texra/v1/global-storage/config.json`. One provider per process is
        // what keeps a value `texra config` writes readable at the next startup.
        const roots = createNodeWorkspaceRoots({
          workspacePath: context.cwd,
          storageRoot,
          storage,
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
            Effect.flatMap(
              context.interruptedTasks === 'setting'
                ? interruptedTasksOnOpen(roots)
                : Effect.succeed(context.interruptedTasks),
              (interruptedTasks) =>
                sessions.open(roots, {
                  persistent: true,
                  host: { ...(interruptedTasks && { interruptedTasks }) },
                }),
            ),
            (session) => Effect.asVoid(sessions.close(session.roots)),
          ).pipe(
            Effect.tap(recordFirstCompletedRun),
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

        // The one-time telemetry notice: a single stderr line, then a state
        // flag. A quiet run neither prints it nor marks it shown.
        if (!context.quietLogs) {
          const notice = yield* telemetryNoticeIfDue(roots.config);
          if (notice) writeTextStderr(notice);
        }

        // The shutdown is this scope's close, its finalizers run in the
        // reverse of their registration: every session closes first (its
        // runs stopped and finished, its artifacts flushed). That stops
        // agent-spawned OS children before the process exits, as the
        // extension and desktop hosts do: a background `bash` run is its own
        // process group (see execUtils), which its lifeline kills only once
        // `texra` is gone, and this close stops it first so its run finishes.
        // Then the project scope, and the runtime last, draining the usage
        // log.
        const scope = Scope.makeUnsafe();
        yield* Scope.addFinalizer(scope, disposeCliProcessRuntime);
        yield* Scope.addFinalizer(scope, closeProject);
        yield* Scope.addFinalizer(scope, Effect.asVoid(sessions.closeAll));
        const platform = {
          roots,
          session: openSession,
          shutdownScope: scope,
          shutdown: yield* Effect.cached(Scope.close(scope, Exit.void)),
        };
        installed = platform;
        shutdownQuiet = context.quietLogs;
        if (context.installSignalHandlers !== false)
          holdSignals(platformSignalPolicy);
        return { globalState, platform };
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? closeProject : Effect.void,
        ),
      );
    }),
  );

  const { roots } = platform;

  const cliServices: CliPlatformServices = {
    runtime,
    config: roots.config,
    workspaceState: roots.workspaceState,
    repoState: roots.repoState,
    globalState,
    session: platform.session,
    shutdownScope: platform.shutdownScope,
    roots,
  };

  return cliServices;
});
