// Signal handling and exit choreography for the chat TUI: the SIGINT/SIGTERM/
// SIGHUP/SIGTSTP/SIGCONT policy, the double-tap-to-exit confirmation, and the
// cause-aware teardown. Terminal state itself belongs to the `TuiTerminal`
// this controller is handed.
//
// Every exit path enters `leave`, which decides the chat's exit once
// (`TuiSession.exited`) and does the synchronous part: a signal restores the
// terminal before its first await, then skips the graceful drain and leaves
// with the signal's code through the platform's one exit.

import { Cause, Effect, Exit, FiberHandle, Option, Scope } from 'effect';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@texra-ai/harness/host';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { readCliCwd } from '@cli/runtime/platform/cliContext';
import { CliExitCode } from '@cli/runtime/platform/exitCodes';
import { leaveAtOnce, runCliExit } from '@cli/runtime/platform/initPlatform';
import {
  writeTextStderrAndWait,
  writeTextStdout,
} from '@cli/runtime/platform/logSinks';
import {
  holdSignals,
  type SignalPolicy,
} from '@cli/runtime/platform/processSignals';
import {
  supportsTerminalJobControl,
  type TuiTerminal,
} from '@cli/tui/terminalCleanup';

import {
  resetCliState,
  clearTransientNotice,
  rootRunId as rootRunIdSignal,
  setTransientNotice,
} from './state/cliState';
import { currentView } from './state/sessionView';

interface ResumeHintSnapshot {
  readonly view: SessionView;
  readonly rootRunId: RunId | undefined;
}
import { collectResumeUsage, formatResumeHint } from './state/resumeHint';
import {
  canStopRootRun,
  type ChatExit,
  type TuiSession,
} from './state/sessionRunState';
import type {
  ApprovalPolicy,
  SessionView,
  RunId,
} from '@texra-ai/harness/schemas';
import type { RunStopReason } from '@texra-ai/harness';
import type { Instance as InkInstance } from 'ink';

const EXIT_CONFIRMATION_TTL_MS = 800;

/**
 * Runtime session values the exit subsystem reads. Everything else it needs
 * (signals, resume-hint formatters, terminal-mode helpers, platform shutdown)
 * is a module-level import, so only these session-scoped bindings are threaded
 * through.
 */
interface SessionExitControllerContext {
  /** The mounted Ink instance whose `unmount()` drives the exit. */
  readonly ink: InkInstance;
  /** Mutable run-state record shared with the rest of the session. */
  readonly session: TuiSession;
  /** `context.commandName` — names the resume command in the exit hint. */
  readonly commandName: string;
  /** `context.cwd` — the launch directory shown in the resume hint. */
  readonly cwd: string;
  /** The chat's scope: what the session holds, closed and awaited on
   *  graceful exit. */
  readonly chatScope: Scope.Closeable;
  /** The TUI's hold on the terminal, suspended, resumed and released here. */
  readonly terminal: TuiTerminal;
  /** The process runtime the exit drain runs on: one run per exit path. */
  readonly runtime: ProcessRuntime;
  /** The platform's exit: its shutdown, the flushes, then `process.exit`. */
  readonly leaveProcess: (code: number) => Effect.Effect<never>;
  /** Finishes once every message the chat was sending is sent (or started
   *  its run); a graceful exit waits on it before it returns. */
  readonly submitted: Effect.Effect<void>;
  /** Finishes once the chat's root run is no longer live here: what a
   *  graceful exit that stopped it waits for. */
  readonly rootRunEnded: Effect.Effect<void>;
  /** Reads the live approval policy for the resume hint. */
  readonly getApprovalPolicy: () => ApprovalPolicy;
  /** Materialize buffered trace chunks and drain queued publications. */
  readonly flushArtifacts: Effect.Effect<void, Error>;
  /** Repaint the TUI from a known origin after a `fg`/SIGCONT resume. */
  readonly repaintAfterTerminalResume: () => void;
  /** Stop the active run (its `run.stop` row): Ctrl-C on a running turn
   *  is a `user` stop, every exit path a `shutdown`. */
  readonly interruptActive: (reason: RunStopReason) => void;
}

/** The exit-subsystem handles `runChat` wires into Ink props and its `finally`. */
interface SessionExitController {
  /** SIGINT / Ctrl-C handler (double-tap-to-exit, or clean/force/preserve exit). */
  readonly handleSigint: () => void;
  /** SIGTSTP / Ctrl-Z handler (restore terminal, then SIGSTOP). */
  readonly handleSigtstp: () => void;
  /** Leave gracefully unless an exit was already decided (`/exit`, a
   *  Ctrl-C with nothing to stop, Ink ending): the one exit's result, with
   *  the code the chat ends with. */
  readonly exit: () => Promise<CliExitCode>;
}

/**
 * The chat's exit controller. It holds the process signals under its policy
 * from the moment it is made, so the caller makes it exactly when the chat
 * takes the signals over from the platform.
 */
export function createSessionExitController(
  ctx: SessionExitControllerContext,
): SessionExitController {
  const { ink, session } = ctx;

  // While its fiber sleeps, a second Ctrl-C leaves at once. The notice is
  // regenerable display state; replacing it must not change whether that
  // second Ctrl-C confirms the exit the first one asked for.
  const confirmation = ctx.runtime.runSync(
    Scope.provide(FiberHandle.make<void>(), ctx.chatScope),
  );
  const terminalJobControlSupported = supportsTerminalJobControl();
  // Persist the reopen hint to native scrollback: the session's root run,
  // through which its children resume too. The view (for the task's usage)
  // is read before resetCliState() clears it, as a snapshot taken while the
  // session adapter was still bound.
  const snapshotResumeHint = (): ResumeHintSnapshot => ({
    view: currentView(),
    rootRunId: rootRunIdSignal.get(),
  });
  const printResumeHintOnExit = (snapshot: ResumeHintSnapshot): void => {
    if (!snapshot.rootRunId) return;
    const hint = formatResumeHint(
      snapshot.rootRunId,
      collectResumeUsage(snapshot.view, snapshot.rootRunId),
      ctx.commandName,
      {
        cwd: ctx.cwd,
        processCwd: readCliCwd(),
        approvalPolicy: ctx.getApprovalPolicy(),
      },
    );
    writeTextStdout(`\n${hint}`);
  };
  // Drain artifact writes and canonical event publication before shutdown.
  // Platform shutdown then finishes executions whose leases are still held,
  // including the WAITING flow whose checkpoint this exit preserves. Every
  // exit persists best-effort: a failed flush is reported and the exit goes
  // on, since the resume hint still names the session and the terminal must
  // still be restored.
  const persistSession = ctx.flushArtifacts.pipe(
    Effect.catchCause((cause) =>
      writeTextStderrAndWait(
        `[warn] [cli.lifecycle] Transcript flush failed during exit; the session tail may be missing: ${toErrorMessage(Cause.squash(cause))}`,
      ),
    ),
  );

  // The rest of the exit, once `leave` decided it: one program on the
  // default runtime (`runCliExit`), off the process runtime the platform's
  // shutdown disposes. A signal exit persists the session and leaves with
  // the signal's code; a graceful one drains the chat first.
  const exitProgram = Effect.fn(function* (cause: ChatExit) {
    if (cause.kind === 'signal') {
      // `persistSession` and the shutdown sequence catch their own failures,
      // so the exit is unconditional.
      yield* withProcessServices(ctx.runtime, persistSession);
      return yield* ctx.leaveProcess(cause.exitCode);
    }
    // The drain starts once Ink has unmounted, and reads the view before
    // closing ctx.chatScope ends the session's subscriptions: the resume
    // hint prints later.
    yield* Effect.promise(async () => {
      await ink.waitUntilExit();
    });
    const resumeHint = snapshotResumeHint();
    // A suspended (idle/WAITING) root session is resumable, so it takes no
    // stop: the checkpoint survives either way, and the session's close
    // ends the generation on its own. See TuiSession.isResumableIdle for
    // the live-flow check that distinguishes this state from a resume that
    // is still rehydrating. This is the one stop policy of a graceful
    // exit (`/exit` and Ctrl-C alike); a signal exit stops the run in its
    // handler, before it leaves.
    const interruptPendingRun = (): boolean => {
      if (session.canStartRootRun() || session.isResumableIdle()) return false;
      ctx.interruptActive('shutdown');
      return true;
    };
    // Interrupt an actively-running turn BEFORE waiting for the chat's sends:
    // a message to a stopping run lands only once the stop finishes. Re-check
    // after the wait for a run a send itself resumed.
    const { disposalFailure, resumableIdle } = yield* withProcessServices(
      ctx.runtime,
      Effect.gen(function* () {
        // A disposal failure does not stop the exit: it is reported and
        // rethrown once the session is persisted and the terminal restored.
        const closed = yield* Effect.exit(
          Scope.close(ctx.chatScope, Exit.void),
        );
        const disposalFailure = Exit.isFailure(closed)
          ? ensureError(Cause.squash(closed.cause))
          : undefined;
        let interrupted = interruptPendingRun();
        yield* ctx.submitted;
        interrupted = interruptPendingRun() || interrupted;
        const idle = session.isResumableIdle();
        // Only await a run we actually interrupted/finished. A resumableIdle
        // run is waiting at the WAIT node and never finishes, so awaiting it
        // would hang the process here. The run's own outcome is not the exit's
        // concern: an interrupt-only finish must not skip the teardown below.
        if (interrupted) yield* ctx.rootRunEnded;
        yield* persistSession;
        return { disposalFailure, resumableIdle: idle };
      }),
    );
    ctx.terminal.release();
    // The code the chat ends with: the drain above awaited the run, so its
    // outcome is final, and resetCliState() below clears the root.
    const exitCode = session.exitCode;
    // Print the resume hint after the terminal modes are restored, but before
    // resetCliState() clears the stream tree the hint is built from.
    printResumeHintOnExit(resumeHint);
    resetCliState();
    if (resumableIdle) {
      // The run waiting at the WAIT node keeps the event loop alive, so a
      // normal return would never let the process exit. Leave here, AFTER
      // persistence is flushed and the resume hint is printed, preserving the
      // suspended flow record on disk for `texra resume`. Terminal modes are
      // restored, so stderr is the operator's again; the log sink is silent
      // for the whole TUI session and would drop this.
      if (disposalFailure) {
        yield* writeTextStderrAndWait(
          `[error] [cli.sessionExit] Session resource disposal failed during exit: ${toErrorMessage(disposalFailure)}`,
        );
      }
      return yield* ctx.leaveProcess(
        disposalFailure ? CliExitCode.AgentError : exitCode,
      );
    }
    if (disposalFailure) return yield* Effect.fail(disposalFailure);
    return exitCode;
  });

  /**
   * Every exit path enters here; the first decides how the chat leaves. The
   * synchronous part is load-bearing: the signals pass to `leaveAtOnce`
   * (a later Ctrl-C never reaches the confirmation), and a signal exit
   * restores the terminal and prints the hint before the first await, so a
   * stalled flush cannot strand raw mode or emulator keyboard state.
   */
  const leave = (cause: ChatExit): Promise<CliExitCode> => {
    if (session.exited) return session.exited;
    releaseSignals();
    holdSignals(leaveAtOnce);
    clearTransientNotice();
    ink.unmount();
    if (cause.kind === 'signal') {
      ctx.terminal.release();
      printResumeHintOnExit(snapshotResumeHint());
    }
    return (session.exited = runCliExit(exitProgram(cause)));
  };
  const waitForSecondCtrlC = (): void => {
    setTransientNotice('Press Ctrl-C again to exit', {
      kind: 'exit',
      resumeId: rootRunIdSignal.get(),
      ttlMs: EXIT_CONFIRMATION_TTL_MS,
    });
    ctx.runtime.runSync(
      FiberHandle.run(confirmation, Effect.sleep(EXIT_CONFIRMATION_TTL_MS)),
    );
  };
  const handleSigint = (): void => {
    // A second Ctrl-C inside the confirmation window forces the exit.
    if (Option.isSome(FiberHandle.getUnsafe(confirmation))) {
      void leave({ kind: 'signal', exitCode: CliExitCode.Interrupted });
    } else if (canStopRootRun.get()) {
      ctx.interruptActive('user');
      waitForSecondCtrlC();
    } else if (session.isResumableIdle()) {
      // Exit WITHOUT a user stop. The suspended tool-use run keeps its rows
      // on the run aggregate, so `texra resume` can continue it. Preserve
      // the session's current exit code too: an intentional idle exit after
      // a successful turn should not report SIGINT/130. The platform
      // shutdown's session close still ends the generation with its
      // cancelled `run.end` (see `TuiSession.isResumableIdle`).
      void leave({ kind: 'signal', exitCode: session.exitCode });
    } else {
      void leave({ kind: 'graceful' });
    }
  };
  // Only interrupt an actively-running turn; an idle/WAITING session is left
  // suspended so its rows stay resumable (see handleSigint).
  const handleTermSignal = (exitCode: number) => (): void => {
    if (canStopRootRun.get()) {
      ctx.interruptActive('shutdown');
    }
    void leave({ kind: 'signal', exitCode });
  };
  // Suspend/resume (Ctrl-Z / `kill -TSTP` / `fg`). Raw mode keeps the tty
  // driver from ever turning ^Z into a signal, so App's unified useInput
  // routes the parsed Ctrl-Z here explicitly; external SIGTSTP lands in the
  // same handler. Restore the terminal for the shell before stopping, then
  // stop with SIGSTOP — this handler replaced the default stop action, so
  // re-raising SIGTSTP would just recurse.
  const handleSigtstp = (): void => {
    if (!terminalJobControlSupported) return;
    ctx.terminal.suspend();
    process.kill(process.pid, 'SIGSTOP');
  };
  // After `fg`, repaint from a known origin: the shell prompt and `fg` echo
  // have polluted the screen, so the same clear-and-reprint path as a width
  // change is the only safe redraw.
  const handleSigcont = (): void => {
    ctx.terminal.resume();
    ctx.repaintAfterTerminalResume();
  };

  // The newest holder answers, so this policy is the sole owner until
  // `leave` releases it.
  const policy: SignalPolicy = {
    SIGINT: handleSigint,
    SIGTERM: handleTermSignal(CliExitCode.Terminated),
    SIGHUP: handleTermSignal(129),
    ...(terminalJobControlSupported && {
      SIGTSTP: handleSigtstp,
      SIGCONT: handleSigcont,
    }),
  };
  const releaseSignals = holdSignals(policy);

  return {
    handleSigint,
    handleSigtstp,
    exit: () => leave({ kind: 'graceful' }),
  };
}
