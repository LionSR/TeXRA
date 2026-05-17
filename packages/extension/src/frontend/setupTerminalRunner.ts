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
 */

// Third-party imports
import * as vscode from 'vscode';
import stripAnsi from 'strip-ansi';

// Local imports - hosts
import type {
  TerminalRunRequest,
  TerminalRunResult,
} from '@hosts/terminalHost';

const OUTPUT_MAX_CHARS = 12_000;
const SHELL_INTEGRATION_WAIT_MS = 2_000;
const READER_DRAIN_MS = 250;

export async function runTerminalCommand(
  args: TerminalRunRequest,
): Promise<TerminalRunResult> {
  const terminal = revealTerminal(args);
  const integration = await waitForShellIntegration(
    terminal,
    SHELL_INTEGRATION_WAIT_MS,
  );

  if (!integration) {
    terminal.sendText(args.command, true);
    return { exitCode: undefined, output: '', timedOut: false };
  }

  return captureExecution(integration, args.command, args.timeoutMs);
}

/**
 * Reuse a same-named, still-running terminal so repeated calls don't
 * pile up tabs. Already-exited terminals stay in `terminals` until the
 * user closes them; treat those as gone.
 */
function revealTerminal(request: TerminalRunRequest): vscode.Terminal {
  const { name, cwd, env } = request;
  const hasLaunchOverrides = cwd !== undefined || env !== undefined;
  const existing = hasLaunchOverrides
    ? undefined
    : vscode.window.terminals.find(
        (t) => t.name === name && t.exitStatus === undefined,
      );
  const terminal = existing ?? vscode.window.createTerminal({ name, cwd, env });
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

async function captureExecution(
  integration: vscode.TerminalShellIntegration,
  command: string,
  timeoutMs: number,
): Promise<TerminalRunResult> {
  const execution = integration.executeCommand(command);

  // Exit code is delivered via the global end-event, not the execution
  // object itself, so subscribe before reading.
  const raced = raceWithTimeout<number | undefined>(
    (resolve) =>
      vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution === execution) resolve(event.exitCode);
      }),
    timeoutMs,
  );

  // Drain the stream into a sliding-window tail. `.catch` swallows
  // late stream errors (terminal closed after we stopped awaiting)
  // so they cannot bubble up as unhandled rejections.
  const reader = tail(execution.read(), OUTPUT_MAX_CHARS).catch(() => '');

  const result = await raced;

  // Drain any final chunks; bound the wait so a hung reader can't
  // block the agent forever.
  const output = await Promise.race([
    reader,
    new Promise<string>((resolve) =>
      setTimeout(() => resolve(''), READER_DRAIN_MS),
    ),
  ]);

  return {
    exitCode: result.timedOut ? undefined : result.value,
    output: stripAnsi(output),
    timedOut: result.timedOut,
  };
}

type Raced<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Race a one-shot event subscription against a timeout. Disposes the
 * subscription and clears the timer in whichever branch wins so we
 * never leak listeners or pending timers.
 */
function raceWithTimeout<T>(
  subscribe: (resolve: (value: T) => void) => vscode.Disposable,
  timeoutMs: number,
): Promise<Raced<T>> {
  return new Promise((resolve) => {
    // Predeclared with `let` so the `settle` closure can read them
    // even if `subscribe` fires its callback synchronously (would
    // otherwise hit the TDZ for the original `const` bindings).
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    let disposable: vscode.Disposable | undefined = undefined;
    const settle = (result: Raced<T>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      disposable?.dispose();
      resolve(result);
    };
    disposable = subscribe((value) => settle({ timedOut: false, value }));
    if (settled) {
      // `subscribe` already resolved synchronously; settle() ran
      // before `disposable` was assigned, so dispose now and skip
      // the timer entirely.
      disposable.dispose();
      return;
    }
    timer = setTimeout(() => settle({ timedOut: true }), timeoutMs);
  });
}

/**
 * Drain an async iterable into a length-capped sliding-window tail.
 * Caller may abandon the returned promise; chunk errors are surfaced
 * to the caller for them to decide whether to swallow.
 */
async function tail(
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
