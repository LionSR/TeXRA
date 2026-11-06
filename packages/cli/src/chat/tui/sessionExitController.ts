// Signal handling and exit choreography for the chat TUI: the SIGINT/SIGTERM/
// SIGHUP/SIGTSTP/SIGCONT policy, the double-tap-to-exit confirmation, and the
// cause-aware teardown. Terminal state itself belongs to the `TuiTerminal`
// this controller is handed.
//
// Every exit path enters `leave`, which decides the chat's exit once
// (`TuiSession.exit`) and does the synchronous part: a signal restores the
// terminal before its first await, then skips the graceful drain and leaves
// with the signal's code through the platform's one exit.

import { Cause, Deferred, Effect, Exit, Scope } from 'effect';
import {
  withProcessServices,
  type ProcessRuntime,
} from '@texra-ai/harness/host';
import { ensureError, toErrorMessage } from '@texra-ai/harness/schemas';
import { readCliCwd } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { cliExit, leaveAtOnce, runCliExit } from '@cli/runtime/initPlatform';
import { writeTextStderrAndWait, writeTextStdout } from '@cli/runtime/logSinks';
import { holdSignals, type SignalPolicy } from '@cli/runtime/processSignals';
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
  chatTuiRunPending,
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
  /** Finishes once every message the chat was sending is sent (or started
   *  its run); a graceful exit waits on it before it returns. */
  readonly submitted: Effect.Effect<void>;
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
  /** Leave on the chat's own decision (`/exit`, a Ctrl-C with nothing to
   *  stop): unmount, then the graceful drain. */
  readonly requestInputExit: () => void;
  /** Hold the process signals under this controller's policy. */
  readonly install: () => void;
  /** The post-`waitUntilExit` graceful teardown: decides a graceful exit if
   *  none was decided yet, and finishes once the exit's drain has, with the
   *  code the chat ends with. */
  readonly gracefulTeardown: () => Promise<CliExitCode>;
}

export function createSessionExitController(
  ctx: SessionExitControllerContext,
): SessionExitController {
  const { ink, session } = ctx;

  // A second Ctrl-C before this instant leaves at once. The notice is
  // regenerable display state; replacing it must not change whether that
  // second Ctrl-C confirms the exit the first one asked for.
  let secondCtrlCExitsUntil = 0;
  const terminalJobControlSupported = supportsTerminalJobControl();
  // The TUI's hold on the signals, released as it leaves.
  let releaseSignals = (): void => {};
  // The one run of the exit, started by the path that decides it.
  let exited: Promise<CliExitCode> | undefined;
  // Persist the reopen hint to native scrollback: the session's root run,
  // through which its children resume too. The view (for the task's usage)
  // is read before resetCliState() clears it, as a snapshot taken while the
  // session adapter was still bound.
  const snapshotResumeHint = (): ResumeHintSnapshot => ({
    view: currentView(),
    rootRunId: rootRunIdSignal.get(),
  });
  const printResumeHintOnExit = (snapshot: ResumeHintSnapshot): void => {
    if (!session.runId) return;
    const hint = formatResumeHint(
      session.runId,
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
  const exitProgram = Effect.gen(function* () {
    const cause = yield* Deferred.await(session.exit);
    if (cause.kind === 'signal') {
      // `persistSession` and the shutdown sequence catch their own failures,
      // so the exit is unconditional.
      yield* withProcessServices(ctx.runtime, persistSession);
      return yield* cliExit(cause.exitCode);
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
    // the live-flow check that distinguishes this state from a resume slot
    // that is still rehydrating. This is the one stop policy of a graceful
    // exit (`/exit` and Ctrl-C alike); a signal exit stops the run in its
    // handler, before it leaves.
    const interruptPendingRun = (): boolean => {
      if (!chatTuiRunPending(session) || session.isResumableIdle())
        return false;
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
        if (interrupted && session.runSettled) {
          yield* Effect.ignoreCause(session.runSettled);
        }
        yield* persistSession;
        return { disposalFailure, resumableIdle: idle };
      }),
    );
    ctx.terminal.release();
    // The code the chat ends with: the drain above awaited the run, so the
    // claim's code is final, and resetCliState() below clears the claim.
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
      return yield* cliExit(
        disposalFailure ? CliExitCode.AgentError : exitCode,
      );
    }
    if (disposalFailure) return yield* Effect.fail(disposalFailure);
    return exitCode;
  });

  /**
   * Every exit path enters here; the first decides how the chat leaves. The
   * synchronous part is load-bearing: the signals pass to `leaveAtOnce`, the
   * pending Ctrl-C confirmation is void, and a signal exit restores the
   * terminal and prints the hint before the first await, so a stalled flush
   * cannot strand raw mode or emulator keyboard state.
   */
  const leave = (cause: ChatExit): void => {
    if (session.leaving) return;
    releaseSignals();
    holdSignals(leaveAtOnce);
    secondCtrlCExitsUntil = 0;
    clearTransientNotice();
    ink.unmount();
    if (cause.kind === 'signal') {
      ctx.terminal.release();
      printResumeHintOnExit(snapshotResumeHint());
    }
    Deferred.doneUnsafe(session.exit, Effect.succeed(cause));
    exited ??= runCliExit(exitProgram);
  };
  const waitForSecondCtrlC = (): void => {
    secondCtrlCExitsUntil = Date.now() + EXIT_CONFIRMATION_TTL_MS;
    setTransientNotice('Press Ctrl-C again to exit', {
      kind: 'exit',
      resumeId: session.runId,
      ttlMs: EXIT_CONFIRMATION_TTL_MS,
    });
  };
  const handleSigint = (): void => {
    // A second Ctrl-C inside the confirmation window forces the exit.
    if (Date.now() < secondCtrlCExitsUntil) {
      leave({ kind: 'signal', exitCode: CliExitCode.Interrupted });
    } else if (session.canStopVisibleRun()) {
      ctx.interruptActive('user');
      waitForSecondCtrlC();
    } else if (session.isResumableIdle()) {
      // Exit WITHOUT a user stop. The suspended tool-use run keeps its rows
      // on the run aggregate, so `texra resume` can continue it. Preserve
      // the session's current exit code too: an intentional idle exit after
      // a successful turn should not report SIGINT/130. The platform
      // shutdown's session close still ends the generation with its
      // cancelled `run.end` (see `TuiSession.isResumableIdle`).
      leave({ kind: 'signal', exitCode: session.exitCode });
    } else {
      leave({ kind: 'graceful' });
    }
  };
  // Only interrupt an actively-running turn; an idle/WAITING session is left
  // suspended so its rows stay resumable (see handleSigint).
  const handleTermSignal = (exitCode: number) => (): void => {
    if (session.canStopVisibleRun()) {
      ctx.interruptActive('shutdown');
    }
    leave({ kind: 'signal', exitCode });
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

  const install = (): void => {
    // Held right here, not any earlier: everything before this (the platform
    // init, onboarding, model resolution) ran under the platform's own
    // policy, so a signal during that window still got a graceful shutdown.
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
    releaseSignals = holdSignals(policy);
  };

  const gracefulTeardown = (): Promise<CliExitCode> => {
    leave({ kind: 'graceful' });
    return (exited ??= runCliExit(exitProgram));
  };

  return {
    handleSigint,
    handleSigtstp,
    requestInputExit: () => leave({ kind: 'graceful' }),
    install,
    gracefulTeardown,
  };
}
