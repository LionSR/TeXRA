// Signal handling and exit choreography for the chat TUI: the SIGINT/SIGTERM/
// SIGHUP/SIGTSTP/SIGCONT handlers, the double-tap-to-exit confirmation, and the
// cause-aware teardown. Terminal state itself belongs to the `TuiTerminal`
// this controller is handed.
//
// Teardown ownership: signal and ordinary exits enter one memoized operation.
// A signal cause restores terminal modes synchronously before its first await,
// then skips the graceful queue/run drain and exits with the signal code.

import { Cause, Effect } from 'effect';
import { readCliCwd } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import {
  handOffCliShutdownSignalHandlers,
  runCliPlatformShutdownSequence,
} from '@cli/runtime/initPlatform';
import { writeTextStderrAndWait, writeTextStdout } from '@cli/runtime/logSinks';
import {
  supportsTerminalJobControl,
  type TuiTerminal,
} from '@cli/tui/terminalCleanup';
import { DisposableStore } from '@platform/disposable';
import type { LifecycleHost } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { RunId } from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

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
import {
  collectResumeTargets,
  collectResumeUsage,
  formatResumeHint,
} from './state/resumeHint';
import { chatTuiRunPending, type TuiSession } from './state/sessionRunState';
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
  /**
   * The platform lifecycle host `runChat` received from the CLI composition
   * root; these exit paths call `process.exit()` directly, so they run the
   * shutdown sequence themselves rather than leaving it to `bin/texra.ts`.
   */
  readonly lifecycle: LifecycleHost;
  /** `context.commandName` — names the resume command in the exit hint. */
  readonly commandName: string;
  /** `context.cwd` — the launch directory shown in the resume hint. */
  readonly cwd: string;
  /** Session-scoped subscriptions torn down on graceful exit. */
  readonly disposables: DisposableStore;
  /** The TUI's hold on the terminal, suspended, resumed and released here. */
  readonly terminal: TuiTerminal;
  /** The process runtime the exit drain runs on: one run per exit path. */
  readonly runtime: ProcessRuntime;
  /** Settles once the follow-up delivery queue has drained; a graceful exit
   *  waits on it before it returns. */
  readonly followUpsIdle: Effect.Effect<void>;
  /** Reads the live approval policy for the resume hint. */
  readonly getApprovalPolicy: () => TexraApprovalPolicy;
  /** Materialize buffered trace chunks and drain queued publications. */
  readonly flushArtifacts: Effect.Effect<void, Error>;
  /** Repaint the TUI from a known origin after a `fg`/SIGCONT resume. */
  readonly repaintAfterTerminalResume: () => void;
  /** Stop the active run (writes a `halted` `flow.step`). */
  readonly interruptActive: () => void;
}

/** The exit-subsystem handles `runChat` wires into Ink props and its `finally`. */
interface SessionExitController {
  /** SIGINT / Ctrl-C handler (double-tap-to-exit, or clean/force/preserve exit). */
  readonly handleSigint: () => void;
  /** SIGTSTP / Ctrl-Z handler (restore terminal, then SIGSTOP). */
  readonly handleSigtstp: () => void;
  /** Break the current input wait and unmount without a full teardown. */
  readonly requestInputExit: () => void;
  /** Hand off the platform signal owner and install this controller's handlers. */
  readonly install: () => void;
  /** The post-`waitUntilExit` graceful teardown (joins a signal teardown). */
  readonly gracefulTeardown: () => Promise<void>;
}

type ExitCause =
  | { readonly kind: 'graceful' }
  | { readonly kind: 'signal'; readonly exitCode: number };

export function createSessionExitController(
  ctx: SessionExitControllerContext,
): SessionExitController {
  const { ink, session } = ctx;

  // The notice is regenerable display state; replacing it must not change
  // whether a second Ctrl-C confirms the exit already requested by the first.
  let exitConfirmationExpiresAt = 0;
  const terminalJobControlSupported = supportsTerminalJobControl();
  let teardownPromise: Promise<void> | undefined;
  const signalHandlers = new DisposableStore();
  // Leaving the session: no handler may fire again, and a pending Ctrl-C
  // confirmation is void.
  const detachSignals = (): void => {
    signalHandlers.dispose();
    exitConfirmationExpiresAt = 0;
    clearTransientNotice();
  };
  // Persist the reopen hint to native scrollback: the main session plus each
  // resumable tool-use subagent, so any route can be continued by its own id.
  // Read the runs slice before resetCliState() clears it; the child rosters
  // arrive as a snapshot taken while the session adapter was still bound.
  const printResumeHintOnExit = (snapshot: ResumeHintSnapshot): void => {
    if (!session.runId) return;
    const { view, rootRunId } = snapshot;
    const hint = formatResumeHint(
      collectResumeTargets({ view, rootRunId: session.runId }),
      collectResumeUsage(view, rootRunId),
      ctx.commandName,
      {
        cwd: ctx.cwd,
        processCwd: readCliCwd(),
        approvalPolicy: ctx.getApprovalPolicy(),
      },
    );
    if (hint) writeTextStdout(`\n${hint}`);
  };
  // These TUI exit paths call process.exit() directly, so bin/texra.ts's
  // `finally` (which runs platform shutdown) never fires. Run the same
  // shutdown sequence the (suppressed) platform SIGINT/SIGTERM handlers
  // would have run — lifecycle shutdown (which ends by disposing the process
  // runtime, draining any queued usage entries) then the NDJSON flush — so it
  // still happens once before the process dies. runCliPlatformShutdownSequence
  // is idempotent-safe to call again, so the normal return path can still
  // rely on bin/texra.ts's own `finally`.
  const runPlatformShutdown = (): Promise<void> =>
    runCliPlatformShutdownSequence(ctx.lifecycle);
  // Drain artifact writes and canonical event publication before shutdown.
  // Platform shutdown then settles executions whose leases are still held,
  // including the WAITING flow whose checkpoint this exit preserves. Every
  // exit persists best-effort: a failed flush is reported and the exit goes
  // on, since the resume hint still names the session and the terminal must
  // still be restored.
  const persistSession = ctx.flushArtifacts.pipe(
    Effect.catchCause((cause) =>
      Effect.promise(() =>
        writeTextStderrAndWait(
          `[warn] [cli.lifecycle] Transcript flush failed during exit; the session tail may be missing: ${toErrorMessage(Cause.squash(cause))}`,
        ),
      ),
    ),
  );
  const armExit = (): void => {
    exitConfirmationExpiresAt = Date.now() + EXIT_CONFIRMATION_TTL_MS;
    setTransientNotice('Press Ctrl-C again to exit', {
      kind: 'exit',
      resumeId: session.runId,
      ttlMs: EXIT_CONFIRMATION_TTL_MS,
    });
  };
  const handleSigint = (): void => {
    // A second Ctrl-C inside the confirmation window forces the exit.
    if (Date.now() < exitConfirmationExpiresAt) {
      void teardown({ kind: 'signal', exitCode: CliExitCode.Interrupted });
    } else if (session.canStopVisibleRun()) {
      ctx.interruptActive();
      armExit();
    } else if (session.isResumableIdle()) {
      // Exit WITHOUT interrupting. The suspended tool-use run keeps its latest
      // `flow.snapshot` on the run aggregate, so `texra resume` can continue
      // it. Preserve the session's current terminal status too; an
      // intentional idle exit after a successful turn should not report
      // SIGINT/130. Signal teardown calls process.exit, appending no `halted`
      // step.
      void teardown({ kind: 'signal', exitCode: session.runExitCode });
    } else {
      ctx.interruptActive();
      requestInputExit();
    }
  };
  // Only interrupt an actively-running turn; an idle/WAITING session is left
  // suspended so its `flow.snapshot` stays resumable (see handleSigint).
  const handleTermSignal = (exitCode: number) => (): void => {
    if (session.canStopVisibleRun()) {
      ctx.interruptActive();
    }
    void teardown({ kind: 'signal', exitCode });
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
  function requestInputExit(): void {
    detachSignals();
    ink.unmount();
  }

  const install = (): void => {
    // Ownership transfers right here, not any earlier: everything before this
    // (the platform init, onboarding, model resolution) ran with the
    // platform's own handler still live, so a signal during that window still
    // got a graceful shutdown. This removes it and makes the handlers installed
    // below the sole owner.
    handOffCliShutdownSignalHandlers();
    const handlers: [NodeJS.Signals, () => void][] = [
      ['SIGINT', handleSigint],
      ['SIGTERM', handleTermSignal(CliExitCode.Terminated)],
      ['SIGHUP', handleTermSignal(129)],
    ];
    if (terminalJobControlSupported) {
      handlers.push(['SIGTSTP', handleSigtstp], ['SIGCONT', handleSigcont]);
    }
    for (const [signal, handler] of handlers) {
      process.on(signal, handler);
      signalHandlers.add(() => process.off(signal, handler));
    }
  };

  const beginTeardown = async (cause: ExitCause): Promise<void> => {
    detachSignals();
    // Snapshot the view while it is still bound: disposing ctx.disposables
    // below unbinds it, but the resume hint prints later.
    const resumeHint: ResumeHintSnapshot = {
      view: currentView(),
      rootRunId: rootRunIdSignal.get(),
    };
    if (cause.kind === 'signal') {
      ink.unmount();
      // This synchronous prefix is load-bearing: force/signal exits must restore
      // the terminal before the first await so a stalled flush cannot strand raw
      // mode or emulator keyboard state.
      ctx.terminal.release();
      printResumeHintOnExit(resumeHint);
      // `runCliPlatformShutdownSequence` catches its own failures and never
      // rejects, so there is no catch arm to write here.
      try {
        await ctx.runtime.runPromise(persistSession);
        await runPlatformShutdown();
      } finally {
        process.exit(cause.exitCode);
      }
      return;
    }

    // A suspended (idle/WAITING) root session is resumable, so it is left
    // uninterrupted: the checkpoint survives either way since #11304/#11315,
    // but interrupting would persist a CANCELLED outcome, clear approvals and
    // sweep active children. See TuiSession.isResumableIdle for the live-flow
    // check that distinguishes this state from a resume slot that is still
    // rehydrating.
    //
    // Scope: this owns the policy for the GRACEFUL path only — `/exit` and
    // Ctrl-C's `clean-exit`, both via `requestInputExit`. Signal quits
    // (`handleTermSignal`, and `handleSigint`'s force/preserve arms) return
    // above at the `cause.kind === 'signal'` branch and decide for themselves
    // through `canStopVisibleRun`/`isResumableIdle`.
    //
    // One residual divergence, deliberately left alone: `clean-exit` calls
    // `interruptActive()` itself before `requestInputExit()`, outside this
    // predicate. On a COMPLETED root `chatTuiRunPending` is false, so this arm
    // skips the interrupt while `clean-exit` still runs one — and
    // `RunRegistry.stop`'s child sweep fires even with no root handle. So Ctrl-C
    // on a finished turn still detaches background children where `/exit` does
    // not. Converging that means changing Ctrl-C, which is outside the `/exit`
    // ruling this comment implements.
    const interruptPendingRun = (): boolean => {
      if (!chatTuiRunPending(session) || session.isResumableIdle())
        return false;
      ctx.interruptActive();
      return true;
    };
    // Interrupt an actively-running turn BEFORE draining the queue. A queued
    // follow-up that already entered its recovery path awaits `dispatch.resume`
    // (ToolUseFollowUp), which resolves only when the resumed turn finishes and
    // never observes `stopRequested` — draining first would block the quit
    // behind a long model turn. Re-check after the drain for a run the drain
    // itself started.
    const { disposalFailure, resumableIdle } = await ctx.runtime.runPromise(
      Effect.gen(function* () {
        // A disposal failure does not stop the exit: it is reported and
        // rethrown once the session is persisted and the terminal restored.
        const disposalFailure = yield* Effect.try({
          try: () => ctx.disposables.dispose(),
          catch: ensureError,
        }).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => undefined,
          }),
        );
        let interrupted = interruptPendingRun();
        yield* ctx.followUpsIdle;
        interrupted = interruptPendingRun() || interrupted;
        const idle = session.isResumableIdle();
        // Only await a run we actually interrupted/finished. A resumableIdle
        // run is parked at the WAIT node and never settles, so awaiting it
        // would hang the process here. The run's own outcome is not the exit's
        // concern: an interrupt-only settle must not skip the teardown below.
        if (interrupted && session.runSettled) {
          yield* Effect.ignoreCause(session.runSettled);
        }
        yield* persistSession;
        return { disposalFailure, resumableIdle: idle };
      }),
    );
    ctx.terminal.release();
    // Print the resume hint after the terminal modes are restored, but before
    // resetCliState() clears the stream tree the hint is built from.
    printResumeHintOnExit(resumeHint);
    resetCliState();
    if (resumableIdle) {
      // The run parked at the WAIT node keeps the event loop alive, so a normal return
      // would never let the process exit. Force-exit here, AFTER persistence is
      // flushed and the resume hint is printed, preserving the suspended flow
      // record on disk for `texra resume`. Run platform shutdown first so queued
      // usage logs flush — bin/texra.ts's finally won't on exit().
      // Terminal modes are restored, so stderr is the operator's again; the
      // log sink is silent for the whole TUI session and would drop this.
      if (disposalFailure) {
        await writeTextStderrAndWait(
          `[error] [cli.sessionExit] Session resource disposal failed during exit: ${toErrorMessage(disposalFailure)}`,
        );
      }
      await runPlatformShutdown();
      if (disposalFailure) session.runExitCode = CliExitCode.AgentError;
      process.exit(session.runExitCode);
    }
    if (disposalFailure) throw disposalFailure;
  };

  const teardown = (cause: ExitCause): Promise<void> => {
    teardownPromise ??= beginTeardown(cause);
    return teardownPromise;
  };

  const gracefulTeardown = (): Promise<void> => teardown({ kind: 'graceful' });

  return {
    handleSigint,
    handleSigtstp,
    requestInputExit,
    install,
    gracefulTeardown,
  };
}
