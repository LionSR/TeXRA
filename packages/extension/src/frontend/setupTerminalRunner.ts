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
import stripAnsi from 'strip-ansi';
import * as vscode from 'vscode';

// Local imports - common
import { TERMINAL_OUTPUT_MAX_CHARS } from '@common/terminalOutput';
// Local imports - hosts
import type { TerminalRunRequest, TerminalRunResult } from '@hosts/uiHosts';

import { raceWithTimeout } from './vscode/raceWithTimeout';

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
  const reader = drainStreamTail(
    execution.read(),
    TERMINAL_OUTPUT_MAX_CHARS,
  ).catch(() => '');

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
    output: truncateTerminalOutput(output),
    timedOut: result.timedOut,
  };
}

/** Strip ANSI control sequences and retain the captured output tail. */
function truncateTerminalOutput(output: string): string {
  const stripped = stripAnsi(output);
  return stripped.length > TERMINAL_OUTPUT_MAX_CHARS
    ? stripped.slice(-TERMINAL_OUTPUT_MAX_CHARS)
    : stripped;
}

/**
 * Drain an async iterable into a length-capped sliding-window tail,
 * bounding in-flight memory while streaming. The final ANSI strip and cap
 * happen via {@link truncateTerminalOutput}. Caller may abandon the
 * returned promise; chunk errors are surfaced to the caller for them to
 * decide whether to swallow.
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
