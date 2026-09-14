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
import { Effect, Fiber } from 'effect';
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

import { raceWithTimeout } from './vscode/raceWithTimeout';

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
    const integration = yield* Effect.tryPromise({
      try: () => waitForShellIntegration(terminal, SHELL_INTEGRATION_WAIT_MS),
      catch: (cause) =>
        new TerminalRunFailed({
          reason: 'terminal-unavailable',
          message: 'VS Code would not report terminal shell integration.',
          command: args.command,
          cause,
        }),
    });

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

async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return terminal.shellIntegration;
  const raced = await raceWithTimeout<vscode.TerminalShellIntegration>(
    (resolve) =>
      vscode.window.onDidChangeTerminalShellIntegration((event) => {
        if (event.terminal === terminal) resolve(event.shellIntegration);
      }),
    timeoutMs,
  );
  return raced.timedOut ? undefined : raced.value;
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
  // starts is still observed instead of waiting out the timeout.
  const exitCode = raceWithTimeout<number | undefined>(
    (resolve) =>
      vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) resolve(event.exitCode);
      }),
    args.timeoutMs,
  );

  // Open the stream on this frame so no chunk is missed, then drain it on a
  // child fiber: a late stream error (terminal closed after we stopped
  // reading) is a value this program discards, not an unhandled rejection.
  // Opening it is a host call of its own: a terminal disposed between
  // `executeCommand` and here throws synchronously, and that is this run
  // failing, not a defect. The abandoned exit-code wait resolves on its own
  // timer and disposes its listener, so failing here leaks nothing.
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
    Effect.tryPromise({
      try: () => drainStreamTail(stream, TERMINAL_OUTPUT_MAX_CHARS),
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(''))),
    // Start on this frame, as the abandoned promise did, so iteration begins
    // before the caller suspends on the exit-code event.
    { startImmediately: true },
  );

  const raced = yield* Effect.tryPromise({
    try: () => exitCode,
    catch: (cause) =>
      new TerminalRunFailed({
        reason: 'execution-failed',
        message: 'VS Code would not report the command exit code.',
        command: args.command,
        cause,
      }),
  });

  // Drain any final chunks; bound the wait so a hung reader can't
  // block the agent forever.
  const output = yield* Fiber.join(reader).pipe(
    Effect.timeout(READER_DRAIN_MS),
    Effect.catch(() => Effect.succeed('')),
  );

  return {
    exitCode: raced.timedOut ? undefined : raced.value,
    output: truncateTerminalOutput(output),
    timedOut: raced.timedOut,
  };
});

/** Strip ANSI control sequences and retain the captured output tail. */
function truncateTerminalOutput(output: string): string {
  return stripAnsi(output).slice(-TERMINAL_OUTPUT_MAX_CHARS);
}

/**
 * Drain an async iterable into a length-capped sliding-window tail,
 * bounding in-flight memory while streaming. The final ANSI strip and cap
 * happen via {@link truncateTerminalOutput}. Chunk errors reject; the fiber
 * that drains decides what to do with them.
 */
async function drainStreamTail(
  stream: AsyncIterable<string>,
  maxChars: number,
): Promise<string> {
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk;
    if (buf.length > maxChars) buf = buf.slice(-maxChars);
  }
  return buf;
}
