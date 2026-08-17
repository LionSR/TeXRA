/**
 * Subprocess wrappers for the `lake` commands invoked by `lean_project`.
 *
 * The VS Code Lean extension exposes these as command IDs; the direct adapter
 * has to run the real `lake` binary itself. We serialize per-workspace via an
 * in-process mutex so two agents in the same TeXRA instance can't fire two
 * concurrent `lake build` invocations against the same `.lake/build`.
 */

import * as path from 'node:path';

import { execa } from 'execa';

import { KeyedMutex } from '@utils/core';
import { deriveCommandStderr } from '@utils/system/execUtils';

const LAKE_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LAKE_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
// Keep execa 10's current per-stream failure ceiling explicit. capOutput()
// preserves successful chatty builds by retaining their last 4,194,304 characters, while
// this higher character cap prevents a dependency-default change from silently
// changing when a command is terminated for excessive output.
const LAKE_PROCESS_MAX_BUFFER_CHARS = 100_000_000;

const workspaceMutex = new KeyedMutex<string>();

function capOutput(output: string): string {
  if (output.length <= LAKE_MAX_OUTPUT_CHARS) return output;
  return (
    '…[output truncated]…\n' +
    output.slice(output.length - LAKE_MAX_OUTPUT_CHARS)
  );
}

export interface LakeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LakeCommandOptions {
  workspaceRoot: string;
  lakeCommand: string;
  args: readonly string[];
  /** When true, serialize this invocation against other commands on the same workspace. */
  serialize?: boolean;
  /** Override the default 10-minute timeout. */
  timeoutMs?: number;
}

/**
 * Run a `lake` subcommand against a workspace root. Returns a result instead of
 * throwing on non-zero exit so callers can decide how to format failures.
 */
export async function runLakeCommand(
  options: LakeCommandOptions,
): Promise<LakeCommandResult> {
  if (!options.serialize) {
    return executeLake(options);
  }
  const workspaceKey = path.resolve(options.workspaceRoot);
  return workspaceMutex.runExclusive(workspaceKey, () => executeLake(options));
}

async function executeLake(
  options: LakeCommandOptions,
): Promise<LakeCommandResult> {
  // Lake remains buffer-then-cap deliberately: preserving the current tail
  // result and complete exit diagnostics is simpler than duplicating bash's
  // head/tail streaming policy for this serialized, lower-risk path.
  const result = await execa(options.lakeCommand, [...options.args], {
    cwd: options.workspaceRoot,
    timeout: options.timeoutMs ?? LAKE_RUN_TIMEOUT_MS,
    reject: false,
    maxBuffer: LAKE_PROCESS_MAX_BUFFER_CHARS,
    windowsHide: true,
    stdin: 'ignore',
  });
  const { stdout, stderr } = result;
  const shouldUseShortMessage =
    result.isMaxBuffer ||
    result.exitCode === undefined ||
    result.timedOut ||
    !stdout;
  const stderrOrMessage = deriveCommandStderr(
    stderr,
    result.shortMessage,
    shouldUseShortMessage,
  );
  return {
    exitCode:
      result.failed && (!result.exitCode || result.isMaxBuffer)
        ? -1
        : (result.exitCode ?? -1),
    stdout: capOutput(stdout),
    stderr: capOutput(stderrOrMessage),
  };
}
