/**
 * Setup-tool integrated-terminal runner.
 *
 * Implements `SetupTerminalAdapter.runCommand` for `extension.ts`. Prefers
 * VS Code's stable `Terminal.shellIntegration` API (since 1.93) so the
 * setup agent can read back exit code + output. When shell integration
 * isn't available — custom shell, user disabled the auto-inject, remote
 * SSH edge cases — falls back to `terminal.sendText(command, true)` and
 * reports `captured: false` so the agent knows to ask the user to
 * confirm completion and re-probe.
 */

// Third-party imports
import * as vscode from 'vscode';
import stripAnsi from 'strip-ansi';

// Local imports
import type { TerminalRunResult } from '@tools/setup';

/** Length cap for the captured output tail. */
const OUTPUT_MAX_CHARS = 12_000;
/** How long to wait for shell integration to finish activating on a fresh terminal. */
const SHELL_INTEGRATION_WAIT_MS = 2_000;

/**
 * Run a command in a named integrated terminal and (when possible)
 * return its captured output and exit code.
 *
 * The caller is responsible for approval gating — by the time
 * `runCommand` is called, the user has already approved the command
 * through the normal bash approval surface.
 */
export async function runTerminalCommand(args: {
  name: string;
  command: string;
  timeoutMs: number;
}): Promise<TerminalRunResult> {
  const { name, command, timeoutMs } = args;

  // Reuse a terminal with the same name when present so repeated calls
  // don't clutter the user's terminal panel with duplicate tabs.
  const existing = vscode.window.terminals.find((t) => t.name === name);
  const terminal = existing ?? vscode.window.createTerminal({ name });
  terminal.show();

  const integration = await waitForShellIntegration(
    terminal,
    SHELL_INTEGRATION_WAIT_MS,
  );

  if (!integration) {
    // No shell integration → run the command but give up on capture.
    // Auto-execute (`addNewLine: true`) — the bash approval dialog is
    // the gate, so requiring an extra Enter keystroke would just
    // confuse the user.
    terminal.sendText(command, true);
    return { captured: false, reason: 'no-shell-integration' };
  }

  return captureExecution(integration, command, timeoutMs);
}

/**
 * Wait briefly for `shellIntegration` to populate on a freshly-created
 * terminal. Returns `undefined` if it doesn't show up in time.
 */
async function waitForShellIntegration(
  terminal: vscode.Terminal,
  timeoutMs: number,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) return terminal.shellIntegration;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, timeoutMs);
    const disposable = vscode.window.onDidChangeTerminalShellIntegration(
      (event) => {
        if (event.terminal === terminal) {
          clearTimeout(timer);
          disposable.dispose();
          resolve(event.shellIntegration);
        }
      },
    );
  });
}

async function captureExecution(
  integration: vscode.TerminalShellIntegration,
  command: string,
  timeoutMs: number,
): Promise<TerminalRunResult> {
  const execution = integration.executeCommand(command);

  // Exit code is delivered via the global end-event, not the execution
  // object itself, so subscribe BEFORE we start reading. We resolve
  // when the matching end-event fires, or `undefined` on timeout.
  const exitCodePromise = new Promise<number | undefined>((resolve) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      resolve(undefined);
    }, timeoutMs);
    const disposable = vscode.window.onDidEndTerminalShellExecution(
      (event) => {
        if (event.execution !== execution) return;
        clearTimeout(timer);
        disposable.dispose();
        resolve(event.exitCode);
      },
    );
  });

  let output = '';
  let truncated = false;
  const reader = (async () => {
    for await (const chunk of execution.read()) {
      if (truncated) continue;
      output += chunk;
      if (output.length > OUTPUT_MAX_CHARS) {
        // Keep the tail — for installer / package-manager output the
        // last few lines (success / error message) are what the agent
        // actually needs to interpret.
        output = output.slice(-OUTPUT_MAX_CHARS);
        truncated = true;
      }
    }
  })();

  // Race the exit-code subscription against an explicit timeout. The
  // timer inside `exitCodePromise` resolves with `undefined` after
  // `timeoutMs`; treat that as a timeout signal so the agent can
  // distinguish "command interrupted before completion" from "we gave
  // up waiting".
  let timedOut = false;
  const exitCode = await Promise.race([
    exitCodePromise,
    new Promise<undefined>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve(undefined);
      }, timeoutMs + 50);
    }),
  ]);

  // Drain any final chunks; bound the wait so a hung reader can't
  // block the agent forever.
  await Promise.race([
    reader,
    new Promise<void>((resolve) => setTimeout(resolve, 250)),
  ]);

  return {
    captured: true,
    exitCode,
    output: stripAnsi(output),
    timedOut,
  };
}
