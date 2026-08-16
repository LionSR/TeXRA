// Signal handling, exit choreography, and terminal-teardown for the chat TUI.
//
// Extracted from runChatTui's `runChat` so the exit subsystem — the SIGINT/
// SIGTERM/SIGHUP/SIGTSTP/SIGCONT handlers, the double-tap-to-exit confirmation,
// and the two teardown paths (a synchronous signal exit vs the graceful
// waitUntilExit teardown) — lives as one cohesive unit instead of ~14 closures
// co-captured in the 870-line entry function. This is pure code motion: every
// closure body is unchanged; the only difference is that the runtime session
// values the closures used to capture directly now arrive via an explicit
// {@link SessionExitControllerContext}.
//
// Teardown ownership (unchanged from the inline version): a signal exit runs
// `exitNow()`, which does the full teardown and `process.exit()`s itself; its
// `ink.unmount()` resolves `waitUntilExit` and re-enters `gracefulTeardown()`,
// which no-ops via the `exiting` guard so the drain / hint / cleanup never run
// twice.

import { completeOwnedExecutionLease } from '@agent/storage';
import { readCliCwd } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import {
  handOffCliShutdownSignalHandlers,
  runCliPlatformShutdownSequence,
} from '@cli/runtime/initPlatform';
import { writeTextStdout } from '@cli/runtime/logSinks';
import { createLog } from '@logger/logUtils';
import {
  cleanupTerminalModes,
  restoreTuiInputModes,
  supportsTerminalJobControl,
} from '@cli/tui/terminalCleanup';
import type { DisposableStore } from '@platform/disposable';
import { tryPlatform } from '@platform/platform';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

import {
  resetCliState,
  clearTransientNotice,
  setTransientNotice,
  streams as streamsSignal,
} from './state/cliState';
import { childStreamEntries as childStreamEntriesSignal } from './state/childExecutions';
import {
  collectResumeTargets,
  collectResumeUsage,
  formatResumeHint,
} from './state/resumeHint';
import {
  chatTuiRunPending,
  chatTuiSigintAction,
  type TuiSession,
} from './state/sessionRunState';
import type PQueue from 'p-queue';
import type { Instance as InkInstance } from 'ink';

const log = createLog('cli.sessionExit');
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
  /** Whether this session persists a resumable transcript. */
  readonly canResume: boolean;
  /** Clear iTerm2 progress on teardown (mirrors the render-time flag). */
  readonly clearItermProgress: boolean;
  /** Re-arm the Kitty keyboard protocol on SIGCONT when the terminal supports it. */
  readonly kittyKeyboardEnabled: boolean;
  /** Session-scoped subscriptions torn down on graceful exit. */
  readonly disposables: DisposableStore;
  /** Removes the process-exit terminal backstop after terminal restoration. */
  readonly disposeTerminalRestoreOnExit: () => void;
  /** Follow-up delivery queue drained before a graceful exit returns. */
  readonly followUpQueue: PQueue;
  /** Reads the live approval policy for the resume hint. */
  readonly getApprovalPolicy: () => TexraApprovalPolicy;
  /** Materialize buffered trace chunks + drain debounced StreamLog writes. */
  readonly flushArtifacts: () => Promise<void>;
  /** Repaint the TUI from a known origin after a `fg`/SIGCONT resume. */
  readonly repaintAfterTerminalResume: () => void;
  /** Replace a live attention title with the idle project title while stopped. */
  readonly suspendTerminalTitle: () => void;
  /** Re-project live attention state after the shell returns control. */
  readonly resumeTerminalTitle: () => void;
  /** Whether an actively-running turn can be stopped (vs idle/WAITING). */
  readonly canStopActiveRun: () => boolean;
  /** Whether the session is a resumable-idle exit (preserve the flow record). */
  readonly isResumableIdle: () => boolean;
  /** Stop the active run (clears the flow record). */
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
  /** The post-`waitUntilExit` graceful teardown (no-ops after a signal exit). */
  readonly gracefulTeardown: () => Promise<void>;
}

export function createSessionExitController(
  ctx: SessionExitControllerContext,
): SessionExitController {
  const { ink, session } = ctx;

  // The notice is regenerable display state; replacing it must not change
  // whether a second Ctrl-C confirms the exit already requested by the first.
  let exitConfirmationExpiresAt = 0;
  const terminalJobControlSupported = supportsTerminalJobControl();
  // Set once a signal exit (exitNow) starts: its ink.unmount() resolves
  // waitUntilExit and re-enters gracefulTeardown, which guards on this to avoid
  // draining persistence / printing the resume hint a second time.
  let exiting = false;
  const clearExitConfirmation = (): void => {
    exitConfirmationExpiresAt = 0;
    clearTransientNotice();
  };
  const removeProcessHandlers = (): void => {
    process.off('SIGINT', handleSigint);
    process.off('SIGTERM', handleSigterm);
    process.off('SIGHUP', handleSighup);
    if (terminalJobControlSupported) {
      process.off('SIGTSTP', handleSigtstp);
      process.off('SIGCONT', handleSigcont);
    }
  };
  // Persist the reopen hint to native scrollback: the main session plus each
  // resumable tool-use subagent, so any route can be continued by its own id.
  // Read the streams slice before resetCliState() clears it.
  const printResumeHintOnExit = (): void => {
    if (!ctx.canResume || !session.executionId) return;
    const streams = streamsSignal.get();
    const hint = formatResumeHint(
      collectResumeTargets({
        childStreamEntries: childStreamEntriesSignal.get(),
        rootExecutionId: session.executionId,
        streams,
      }),
      collectResumeUsage(streams),
      ctx.commandName,
      {
        cwd: ctx.cwd,
        processCwd: readCliCwd(),
        approvalPolicy: ctx.getApprovalPolicy(),
      },
    );
    if (hint) writeTextStdout(`\n${hint}`);
  };
  // Materialize buffered trace chunks, then drain the debounced StreamLog disk
  // writes so the tail of the session isn't lost (SAVE_DEBOUNCE_MS window).
  // Persistent flushes have bounded retries; an explicitly ephemeral session
  // has no disk work to drain.
  const persistAndReleaseResumableIdleLease = async (
    resumableIdle: boolean,
  ): Promise<void> => {
    await ctx.flushArtifacts();
    if (resumableIdle && session.executionId) {
      // WAITING deliberately keeps its flow record, but this CLI process is
      // about to exit and can no longer own the execution. Relinquish the
      // durable lease after flushing so an immediate `texra resume` continues
      // the same execution instead of waiting for the stale horizon.
      await completeOwnedExecutionLease(session.executionId);
    }
  };
  // These TUI exit paths call process.exit() directly, so bin/texra.ts's
  // `finally` (which runs platform shutdown) never fires. Run the same
  // shutdown sequence the (suppressed) platform SIGINT/SIGTERM handlers
  // would have run — lifecycle shutdown (notably UsageLogService.dispose(),
  // which flushes any queued usage entries) then the NDJSON flush — so it
  // still happens once before the process dies. runCliPlatformShutdownSequence
  // is idempotent-safe to call again, so the normal return path can still
  // rely on bin/texra.ts's own `finally`.
  const runPlatformShutdown = (): Promise<void> =>
    runCliPlatformShutdownSequence(tryPlatform()?.lifecycle);
  const persistBeforePlatformShutdown = async (
    resumableIdle: boolean,
  ): Promise<void> => {
    try {
      await persistAndReleaseResumableIdleLease(resumableIdle);
    } catch {
      // Signal exit remains best-effort, but platform shutdown must still run.
    }
    try {
      await runPlatformShutdown();
    } catch {
      // process.exit below remains the terminal owner when shutdown fails.
    }
  };
  const exitNow = (exitCode: number): void => {
    const resumableIdle = ctx.isResumableIdle();
    exiting = true;
    ctx.suspendTerminalTitle();
    removeProcessHandlers();
    clearExitConfirmation();
    ink.unmount();
    cleanupTerminalModes({ clearItermProgress: ctx.clearItermProgress });
    // Print the resume hint last, after Ink has torn down and the terminal modes
    // are restored, so it lands at the bottom of the transcript and stays in
    // scrollback (copyable). cleanupTerminalModes no longer disturbs the screen.
    printResumeHintOnExit();
    // Synchronous signal exits (SIGINT double-tap / SIGTERM / SIGHUP) own the
    // whole teardown here (gracefulTeardown skips when `exiting`), so drain
    // persistence and run platform shutdown before exiting. Both steps settle
    // their own failures so none escape under --unhandled-rejections=strict.
    void persistBeforePlatformShutdown(resumableIdle).finally(() =>
      process.exit(exitCode),
    );
  };
  const armExit = (): void => {
    exitConfirmationExpiresAt = Date.now() + EXIT_CONFIRMATION_TTL_MS;
    setTransientNotice('Press Ctrl-C again to exit', {
      kind: 'exit',
      resumeId: ctx.canResume ? session.executionId : undefined,
      ttlMs: EXIT_CONFIRMATION_TTL_MS,
    });
  };
  const handleSigint = (): void => {
    const sigintAction = chatTuiSigintAction({
      exitArmed: Date.now() < exitConfirmationExpiresAt,
      canStopActiveRun: ctx.canStopActiveRun(),
      resumableIdle: ctx.isResumableIdle(),
    });
    switch (sigintAction) {
      case 'clean-exit':
        session.stopRequested = true;
        ctx.interruptActive();
        requestInputExit();
        return;
      case 'force-exit':
        exitNow(CliExitCode.Interrupted);
        return;
      case 'preserve-exit':
        // Resumable-idle: exit WITHOUT interrupting. This preserves the
        // suspended tool-use flow record (executions/<id>/flow-*.json) so
        // `texra resume` can continue it. Preserve the session's current
        // terminal status too; an intentional idle exit after a successful turn
        // should not report SIGINT/130.
        //
        // exitNow() calls process.exit, leaving the flow on disk.
        exitNow(session.runExitCode);
        return;
      case 'interrupt-and-arm-exit':
        session.stopRequested = true;
        ctx.interruptActive();
        armExit();
        return;
      default:
        assertNever(sigintAction, 'Unhandled chat TUI SIGINT action');
    }
  };
  // Only interrupt an actively-running turn; an idle/WAITING session is left
  // suspended so its flow record survives for resume (see handleSigint).
  const handleTermSignal = (exitCode: number): void => {
    if (ctx.canStopActiveRun()) {
      session.stopRequested = true;
      ctx.interruptActive();
    }
    exitNow(exitCode);
  };
  const handleSigterm = (): void => handleTermSignal(143);
  const handleSighup = (): void => handleTermSignal(129);
  // Suspend/resume (Ctrl-Z / `kill -TSTP` / `fg`). Raw mode keeps the tty
  // driver from ever turning ^Z into a signal, so App's unified useInput
  // routes the parsed Ctrl-Z here explicitly; external SIGTSTP lands in the
  // same handler. Restore the terminal for the shell before stopping, then
  // stop with SIGSTOP — this handler replaced the default stop action, so
  // re-raising SIGTSTP would just recurse.
  const handleSigtstp = (): void => {
    if (!terminalJobControlSupported) return;
    ctx.suspendTerminalTitle();
    cleanupTerminalModes({ clearItermProgress: ctx.clearItermProgress });
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.kill(process.pid, 'SIGSTOP');
  };
  // On resume the shell restores only the termios snapshot from suspend time
  // (non-raw, since handleSigtstp dropped raw mode first); the emulator-side
  // modes were popped outright. Re-arm both, then repaint from a known origin
  // — the shell prompt and `fg` echo have polluted the screen, so the same
  // clear-and-reprint path as a width change is the only safe redraw.
  const handleSigcont = (): void => {
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    restoreTuiInputModes({ kittyKeyboard: ctx.kittyKeyboardEnabled });
    ctx.resumeTerminalTitle();
    ctx.repaintAfterTerminalResume();
  };
  function requestInputExit(): void {
    removeProcessHandlers();
    clearExitConfirmation();
    ink.unmount();
  }

  const install = (): void => {
    // Ownership transfers right here, not any earlier: everything before this
    // (initInteractiveCliPlatform, onboarding, model resolution) ran with the
    // platform's own handler still live, so a signal during that window still
    // got a graceful shutdown. This removes it and makes the handlers installed
    // below the sole owner.
    handOffCliShutdownSignalHandlers();
    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
    process.on('SIGHUP', handleSighup);
    if (terminalJobControlSupported) {
      process.on('SIGTSTP', handleSigtstp);
      process.on('SIGCONT', handleSigcont);
    }
  };

  const gracefulTeardown = async (): Promise<void> => {
    // A signal exit (SIGINT/SIGTERM/SIGHUP) runs exitNow(), which does the full
    // teardown and process.exit()s itself; its ink.unmount() resolves
    // waitUntilExit and re-enters here. Skip the entire graceful teardown in
    // that case — re-running it would duplicate the drain / hint / cleanup, and
    // the resumableIdle process.exit() below would race exitNow's async exit,
    // dropping the flush and the signal exit code.
    if (exiting) return;
    removeProcessHandlers();
    clearExitConfirmation();
    let disposalFailed = false;
    let disposalFailure: unknown;
    try {
      ctx.disposables.dispose();
    } catch (error) {
      disposalFailed = true;
      disposalFailure = error;
    }
    await ctx.followUpQueue.onIdle();
    // A suspended (idle/WAITING) root session is resumable: its flow record
    // survives only if we DON'T interrupt the flow (interrupt clears it). See
    // chatTuiIsResumableIdleOnExit for the live-flow check that distinguishes
    // this state from a resume slot that is still rehydrating.
    const resumableIdle = ctx.isResumableIdle();
    if (chatTuiRunPending(session) && !resumableIdle) {
      session.stopRequested = true;
      ctx.interruptActive();
      // Only await a run we actually interrupted/finished. A resumableIdle run
      // is parked at the WAIT node and its runPromise NEVER resolves, so
      // awaiting it would hang the process here.
      await session.runPromise;
    }
    await persistAndReleaseResumableIdleLease(resumableIdle);
    cleanupTerminalModes({ clearItermProgress: ctx.clearItermProgress });
    ctx.disposeTerminalRestoreOnExit();
    // Print the resume hint after the terminal modes are restored, but before
    // resetCliState() clears the stream tree the hint is built from.
    printResumeHintOnExit();
    resetCliState();
    if (resumableIdle) {
      // The dangling runPromise keeps the event loop alive, so a normal return
      // would never let the process exit. Force-exit here, AFTER persistence is
      // flushed and the resume hint is printed, preserving the suspended flow
      // record on disk for `texra resume`. Run platform shutdown first so queued
      // usage logs flush — bin/texra.ts's finally won't on exit().
      if (disposalFailed) {
        log.error(
          `Session resource disposal failed during exit: ${toErrorMessage(disposalFailure)}`,
        );
      }
      await runPlatformShutdown();
      if (disposalFailed) session.runExitCode = CliExitCode.AgentError;
      process.exit(session.runExitCode);
    }
    if (disposalFailed) throw disposalFailure;
  };

  return {
    handleSigint,
    handleSigtstp,
    requestInputExit,
    install,
    gracefulTeardown,
  };
}
