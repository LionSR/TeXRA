/**
 * Setup-tool integrated-terminal runner.
 *
 * Implements the host-neutral `TerminalRunner.runCommand` contract.
 * Prefers VS Code's stable `Terminal.shellIntegration` API (since 1.93)
 * so the agent gets exit code + output. When integration isn't available —
 * custom shell, user
 * disabled the auto-inject, remote SSH edge cases — falls back to
 * `sendText` and returns an empty captured result; the caller sees the
 * same shape as a Ctrl+C interruption and re-probes with `verify_setup`.
 *
 * The runner is an `Effect`: VS Code refusing a terminal or faulting the
 * shell execution reaches the setup tool as `TerminalRunFailed`, and the
 * output drain runs on a child fiber, so a stream error is a value this
 * program discards rather than a rejection nobody is waiting on.
 */

// Third-party imports
import { Effect, Fiber, Option, Stream } from 'effect';
import stripAnsi from 'strip-ansi';
import * as vscode from 'vscode';

// Local imports - common
import { TERMINAL_OUTPUT_MAX_CHARS } from '@common/terminalOutput';
// Local imports - hosts
import {
  TerminalRunFailed,
  type TerminalRunRequest,
  type TerminalRunResult,
} from '@hosts/uiHosts';

const SHELL_INTEGRATION_WAIT_MS = 2_000;
const READER_DRAIN_MS = 250;

export const runTerminalCommand = Effect.fn('setupTerminalRunner.runCommand')(
  function* (
    args: TerminalRunRequest,
  ): Effect.fn.Return<TerminalRunResult, TerminalRunFailed> {
    const terminal = yield* Effect.try({
      try: () => revealTerminal(args),
      catch: (cause) =>
        new TerminalRunFailed({
          reason: 'terminal-unavailable',
          message: 'VS Code would not open an integrated terminal.',
          command: args.command,
          cause,
        }),
    });
    const integration = yield* waitForShellIntegration(
      terminal,
      SHELL_INTEGRATION_WAIT_MS,
    );

    if (!integration) {
      // The terminal can be closed during the shell-integration wait; a
      // disposed terminal throws from sendText, and that is a typed failure
      // of this run, not a defect.
      yield* Effect.try({
        try: () => terminal.sendText(args.command, true),
        catch: (cause) =>
          new TerminalRunFailed({
            reason: 'terminal-unavailable',
            message:
              'The integrated terminal closed before the command was sent.',
            command: args.command,
            cause,
          }),
      });
      return { exitCode: undefined, output: '', timedOut: false };
    }

    return yield* captureExecution(integration, args);
  },
);

/**
 * Reuse a same-named, still-running terminal so repeated calls don't
 * pile up tabs. Already-exited terminals stay in `terminals` until the
 * user closes them; treat those as gone.
 */
function revealTerminal(request: TerminalRunRequest): vscode.Terminal {
  const { name } = request;
  const existing = vscode.window.terminals.find(
    (t) => t.name === name && t.exitStatus === undefined,
  );
  const terminal = existing ?? vscode.window.createTerminal({ name });
  terminal.show();
  return terminal;
}

/**
 * Wait for VS Code to report shell integration for `terminal`, or for
 * `timeoutMs` to elapse. Absent integration is the answer the caller acts on,
 * not a failure: the runner falls back to `sendText`.
 */
function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Effect.Effect<vscode.TerminalShellIntegration | undefined> {
  return Effect.suspend(() => {
    if (terminal.shellIntegration) {
      return Effect.succeed(terminal.shellIntegration);
    }
    return Effect.callback<vscode.TerminalShellIntegration>((resume) => {
      // One disposal path for every exit, as with the exit-code wait below:
      // the event that resumes normally unsubscribes itself, because Effect
      // runs the returned effect only on interruption.
      let subscription: vscode.Disposable | undefined;
      const dispose = () => {
        subscription?.dispose();
        subscription = undefined;
      };
      subscription = vscode.window.onDidChangeTerminalShellIntegration(
        (event) => {
          if (event.terminal === terminal) {
            dispose();
            resume(Effect.succeed(event.shellIntegration));
          }
        },
      );
      return Effect.sync(dispose);
    }).pipe(Effect.timeoutOption(timeoutMs), Effect.map(Option.getOrUndefined));
  });
}

const captureExecution = Effect.fn('setupTerminalRunner.capture')(function* (
  integration: vscode.TerminalShellIntegration,
  args: TerminalRunRequest,
): Effect.fn.Return<TerminalRunResult, TerminalRunFailed> {
  const execution = yield* Effect.try({
    try: () => integration.executeCommand(args.command),
    catch: (cause) =>
      new TerminalRunFailed({
        reason: 'execution-failed',
        message: 'The integrated terminal refused to run the command.',
        command: args.command,
        cause,
      }),
  });

  // Exit code is delivered via the global end-event, not the execution
  // object itself, and VS Code does not replay it: subscribe on this frame,
  // before the stream is opened, so a command that exits while the reader
  // starts is still observed instead of waiting out the timeout. The wait is
  // a child fiber (started on this frame, so the listener is registered
  // before `read()` opens the stream) rather than an abandoned promise: an
  // interrupted run disposes the subscription and cancels the deadline
  // instead of holding both until the timeout elapses.
  const exitCode = yield* Effect.forkChild(
    Effect.callback<number | undefined>((resume) => {
      // One disposal path for every exit. Effect runs the returned effect only
      // when the wait is interrupted — the timeout below, or the whole run
      // being interrupted — so the end event that resumes normally has to
      // unsubscribe itself; without that, every successful command leaves its
      // listener and this execution closure registered for the window's
      // lifetime. `dispose` drops the subscription it disposes, so the two
      // paths can both run.
      let subscription: vscode.Disposable | undefined;
      const dispose = () => {
        subscription?.dispose();
        subscription = undefined;
      };
      subscription = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) {
          dispose();
          resume(Effect.succeed(event.exitCode));
        }
      });
      return Effect.sync(dispose);
    }).pipe(Effect.timeoutOption(args.timeoutMs)),
    { startImmediately: true },
  );

  // Open the stream on this frame so no chunk is missed, then drain it on a
  // child fiber: a late stream error (terminal closed after we stopped
  // reading) is a value this program discards, not an unhandled rejection.
  // Opening it is a host call of its own: a terminal disposed between
  // `executeCommand` and here throws synchronously, and that is this run
  // failing, not a defect. The exit-code fiber is a child of this one, so
  // failing here tears its subscription down with it.
  const stream = yield* Effect.try({
    try: () => execution.read(),
    catch: (cause) =>
      new TerminalRunFailed({
        reason: 'execution-failed',
        message:
          'The integrated terminal closed before its output could be read.',
        command: args.command,
        cause,
      }),
  });
  const reader = yield* Effect.forkChild(
    drainStreamTail(stream, TERMINAL_OUTPUT_MAX_CHARS).pipe(
      Effect.catch(() => Effect.succeed('')),
    ),
    // Start on this frame so iteration begins before the caller suspends on
    // the exit-code event.
    { startImmediately: true },
  );

  const raced = yield* Fiber.join(exitCode);

  // Drain any final chunks; bound the wait so a hung reader can't
  // block the agent forever.
  const output = yield* Fiber.join(reader).pipe(
    Effect.timeout(READER_DRAIN_MS),
    Effect.catch(() => Effect.succeed('')),
  );

  return {
    // `None` is the timeout; `Some(undefined)` is VS Code reporting no exit
    // code for a command that did end. Both read as an absent exit code, and
    // only the first is a timeout.
    exitCode: Option.getOrUndefined(raced),
    output: truncateTerminalOutput(output),
    timedOut: Option.isNone(raced),
  };
});

/** Strip ANSI control sequences and retain the captured output tail. */
function truncateTerminalOutput(output: string): string {
  return stripAnsi(output).slice(-TERMINAL_OUTPUT_MAX_CHARS);
}

/**
 * Drain an async iterable into a length-capped sliding-window tail,
 * bounding in-flight memory while streaming. The final ANSI strip and cap
 * happen via {@link truncateTerminalOutput}. A chunk error fails the effect;
 * the fiber that drains decides what to do with it.
 */
function drainStreamTail(
  stream: AsyncIterable<string>,
  maxChars: number,
): Effect.Effect<string, unknown> {
  return Stream.fromAsyncIterable(stream, (cause) => cause).pipe(
    Stream.runFold(
      () => '',
      (buf: string, chunk: string) => {
        const next = buf + chunk;
        return next.length > maxChars ? next.slice(-maxChars) : next;
      },
    ),
  );
}
