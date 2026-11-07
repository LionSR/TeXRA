// Third-party imports
import { Cause, Context, Effect, Exit, Layer, Scope } from 'effect';

// Local imports
import {
  Sessions,
  type WorkspaceRoots,
  type LocalSession,
  type Session,
  type SessionOpenError,
} from '@texra-ai/harness';
import {
  AppState,
  type ProcessServices,
  type SettingsStores,
  type StateStore,
  type StateWriteFailed,
  StateStores,
} from '@texra-ai/harness/host';
import { openNodeWorkspaceRoots, setLogSink } from '@texra-ai/harness/node';
import { HELPER_MODEL_SETTING } from '@texra-ai/harness/schemas';
import { telemetryNoticeIfDue } from '@telemetry/telemetryNotice';
import { openLocalSession } from '@texra/controllers/session/openProjectSession';
import {
  serviceProjectState,
  serviceSession,
} from '@texra/controllers/server/serviceSession';
import { sessionStoreMovedAsideMessage } from '@ui/copy/sessionStore';

// Local file imports
import type { CliProcessRuntime } from './cliProcessRuntime';
import {
  flushStdout,
  flushTextStderr,
  silentLogSink,
  writeTextStderr,
  writeTextStderrAndWait,
} from './logSinks';
import { CliExitCode } from './exitCodes';
import { holdSignals, type SignalPolicy } from './processSignals';
import { isLinked, linkCliService, type CliServiceLink } from './cliService';
import type { CliContext } from './cliContext';

/** What a command decides about the platform it brings up, beyond its
 *  context. */
export interface CliPlatformOptions {
  /** The command runs or lists tasks, which the service owns: it starts the
   *  service when none runs. Any other command links to a running one. */
  readonly startsService?: boolean;
  /** The command shows `LocalSession.storeMovedAside` itself: the chat TUI,
   *  in its transcript (`createChatSessionController`), since stderr written
   *  before Ink mounts is left above its header. Otherwise the platform
   *  prints it to stderr: its log sink is always silent. */
  readonly presentsStoreMovedAside?: boolean;
  /** `false` only where no signal handler may be installed at all (the TUI
   *  harness). Otherwise the platform holds SIGINT and SIGTERM for as long
   *  as it is up; the chat TUI holds its own policy above it once Ink
   *  mounts, so the newest holder answers. */
  readonly installSignalHandlers?: boolean;
}

/** The context fields the platform reads. */
type CliPlatformContext = Pick<
  CliContext,
  'config' | 'cwd' | 'quietLogs' | 'storageRoot'
>;

/** The platform services a command reads once its platform is up. */
export type CliPlatformServices = SettingsStores & {
  /** The platform's scope: a command that must act before the sessions
   *  close registers there, in a child scope of its own. */
  readonly shutdownScope: Scope.Scope;
  /** The command's runtime, which the platform is a layer of: the modules
   *  that run programs at a Promise edge are handed it. */
  readonly runtime: CliProcessRuntime;
  /** One process, one project: the `--cwd` workspace's roots. */
  readonly roots: WorkspaceRoots;
  /**
   * The process session over those roots, opened by the first step that
   * runs this Effect (a headless `run`, a chat no service serves) and the
   * same session for every later one. `auth`, `doctor`, `models`, `skills`,
   * `tools` and `init` never run it, so a storage root nothing can write to
   * fails a command only when it asks for a transcript.
   */
  readonly session: Effect.Effect<LocalSession, SessionOpenError>;
  /** The storage root's service, linked for the platform's life, when one
   *  answered (or was started, `startsService`); the project's state and
   *  runs are then its ({@link runSession}), and this process opens no store
   *  of the project. Else why none, which the caller says. */
  readonly service: CliServiceLink;
  /** Where the chat's runs and requests land, and the project's stored
   *  runs are read: the service's session when one holds the project, else
   *  {@link session}. */
  readonly runSession: Effect.Effect<Session, SessionOpenError>;
  /**
   * Leave the process with `code`: the platform's scope closes (its
   * sessions stop their runs, then the project closes), the runtime is
   * disposed (draining the usage log), stderr and stdout are flushed, and
   * the process exits. A program for `runCliExit`, never for the runtime it
   * disposes; the caller holds `leaveAtOnce` first so a second signal
   * meanwhile is not Node's default death mid-flush.
   */
  readonly leave: (code: number) => Effect.Effect<never>;
};

/**
 * The one run of an exit program: the platform's signal policy and the chat
 * TUI's teardown run theirs here, on the default runtime, because the exit
 * disposes the process runtime a run on it would be standing on.
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

/**
 * A command's CLI platform, as its runtime serves it: the program that
 * brings the platform up, run by the first step that needs it, with the same
 * result for every later one. Lazy because a command refuses its arguments,
 * reports a failed init in its own words (`models`, `doctor`), or never
 * needs the project at all before it asks.
 */
export class CliPlatform extends Context.Service<
  CliPlatform,
  Effect.Effect<CliPlatformServices, Error, ProcessServices | Sessions>
>()('@texra-ai/cli/CliPlatform') {
  /**
   * The platform of the runtime `runtime` returns, built inside it. What it
   * opens lives in a scope of its own under the layer's, which `leave`
   * closes before it disposes the runtime: that disposal interrupts the
   * command's fibers first, and a headless run's shutdown step must stop
   * its run through the session while the run's program still waits on it.
   */
  static layer(
    context: CliPlatformContext,
    options: CliPlatformOptions,
    runtime: () => CliProcessRuntime,
  ): Layer.Layer<CliPlatform> {
    return Layer.effect(
      CliPlatform,
      Effect.gen(function* () {
        const scope = yield* Scope.fork(yield* Effect.scope);
        return yield* Effect.cached(
          openCliPlatform(context, options, runtime, scope),
        );
      }),
    );
  }
}

/** The command's platform, brought up by the first step that asks. */
export const cliPlatform = CliPlatform.use((open) => open);

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
  return model ? state.update(HELPER_MODEL_SETTING.key, model) : Effect.void;
}

const openCliPlatform = Effect.fn('openCliPlatform')(function* (
  context: CliPlatformContext,
  options: CliPlatformOptions,
  runtime: () => CliProcessRuntime,
  scope: Scope.Closeable,
): Effect.fn.Return<CliPlatformServices, Error, ProcessServices | Sessions> {
  // Every command renders its own output, so the platform's log lines go
  // nowhere.
  setLogSink(silentLogSink, { trusted: true });
  const globalState = yield* AppState;
  const sessions = yield* Sessions;
  // A running service holds the project's state and runs: this process
  // links to it for the platform's life and opens no store of the project,
  // as a window does. None running (or none possible) is the in-process
  // path below.
  const service = yield* linkCliService(
    context.storageRoot,
    options.startsService === true,
  ).pipe(Scope.provide(scope));
  const link = isLinked(service) ? service : undefined;
  // One process, one project: the process roots are the `--cwd` workspace,
  // over the config provider the startup read already opened — the project
  // `.texra/config.json` layered over the user-level
  // `~/.texra/v1/global-storage/config.json`. One provider per process is
  // what keeps a value `texra config` writes readable at the next startup.
  // The project's `texra.db` is owned by the platform's scope; AppState
  // (global) is the runtime's.
  const roots = yield* openNodeWorkspaceRoots({
    workspaceRoot: context.cwd,
    storageRoot: context.storageRoot,
    config: context.config,
    ...(link !== undefined && {
      workspaceState: serviceProjectState(link, context.cwd),
    }),
    stateStores: yield* StateStores,
    globalState,
  }).pipe(Scope.provide(scope));
  // The one open of the process session, memoized so the first step that
  // needs a session opens it and every later one gets the same handle. Its
  // close is registered after the roots', so the session closes first (its
  // runs stopped and finished, its artifacts flushed): that stops
  // agent-spawned OS children before the process exits, as the extension
  // and desktop hosts do — a background `bash` run is its own process group
  // (see execUtils), which its lifeline kills only once `texra` is gone.
  const openSession = yield* Effect.cached(
    openLocalSession(sessions, roots).pipe(
      Scope.provide(scope),
      Effect.tap((session) =>
        Effect.sync(() => {
          const moved = session.storeMovedAside;
          if (moved && options.presentsStoreMovedAside !== true) {
            writeTextStderr(sessionStoreMovedAsideMessage(moved));
          }
        }),
      ),
    ),
  );
  // The service's session of the project, for the platform's life, where
  // the chat's runs and the record reads go.
  const runSession =
    link === undefined
      ? openSession
      : yield* Effect.cached(
          serviceSession(link, context.cwd, roots).pipe(Scope.provide(scope)),
        );

  // The one-time telemetry notice: a single stderr line, then a state
  // flag. A quiet run neither prints it nor marks it shown.
  if (!context.quietLogs) {
    const notice = yield* telemetryNoticeIfDue(roots.config);
    if (notice) writeTextStderr(notice);
  }

  const leave = (code: number): Effect.Effect<never> =>
    leaveProcess(
      Scope.close(scope, Exit.void).pipe(
        Effect.andThen(Effect.suspend(() => runtime().disposeEffect)),
      ),
      context.quietLogs,
    ).pipe(Effect.andThen(Effect.sync(() => process.exit(code))));
  // The platform's own answer to SIGINT and SIGTERM while it is up: leave
  // with the signal's code. Onboarding and model resolution run before Ink
  // mounts and need a graceful exit as much as a headless command does.
  if (options.installSignalHandlers !== false) {
    const onSignal = (code: number) => (): void => {
      holdSignals(leaveAtOnce);
      void runCliExit(leave(code));
    };
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        holdSignals({
          SIGINT: onSignal(CliExitCode.Interrupted),
          SIGTERM: onSignal(CliExitCode.Terminated),
        }),
      ),
      (release) => Effect.sync(release),
    ).pipe(Scope.provide(scope));
  }

  return {
    runtime: runtime(),
    config: roots.config,
    workspaceState: roots.workspaceState,
    repoState: roots.repoState,
    globalState,
    session: openSession,
    service,
    runSession,
    shutdownScope: scope,
    roots,
    leave,
  };
});

/**
 * The shutdown sequence of a process that leaves on its own: `shutdown`,
 * then the stderr and stdout flushes `process.exit` would otherwise cut
 * short. Each step is best effort, so a failure never stops termination,
 * but it is said, on stderr: the process runtime is gone by the flushes,
 * and the log sink is silent under the chat TUI (which has unmounted by
 * now), so only an explicit `--quiet` keeps it unsaid.
 */
function leaveProcess(
  shutdown: Effect.Effect<void>,
  quiet: boolean,
): Effect.Effect<void> {
  const bestEffort = (step: string, effect: Effect.Effect<void>) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        quiet
          ? Effect.void
          : writeTextStderrAndWait(
              `[warn] [cli.shutdown] ${step} failed: ${Cause.pretty(cause)}`,
            ),
      ),
    );
  return Effect.gen(function* () {
    yield* bestEffort('closing the platform', shutdown);
    // A closed pipe must not prevent signal-based termination.
    yield* bestEffort('flushing stderr', flushTextStderr());
    yield* bestEffort('flushing stdout', flushStdout());
  });
}
