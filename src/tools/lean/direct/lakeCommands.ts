/**
 * Subprocess wrappers for the `lake` commands invoked by `lean_project`.
 *
 * The VS Code Lean extension exposes these as command IDs; the direct adapter
 * has to run the real `lake` binary itself. We serialize per-workspace via an
 * in-process mutex so two agents in the same TeXRA instance can't fire two
 * concurrent `lake build` invocations against the same `.lake/build`.
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';

import AsyncLock from 'async-lock';

const LAKE_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LAKE_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;

const workspaceLock = new AsyncLock();

function appendCapped(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= LAKE_MAX_OUTPUT_CHARS) return combined;
  return (
    '…[output truncated]…\n' +
    combined.slice(combined.length - LAKE_MAX_OUTPUT_CHARS)
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
  return workspaceLock.acquire(workspaceKey, () => executeLake(options));
}

function executeLake(options: LakeCommandOptions): Promise<LakeCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.lakeCommand, [...options.args], {
      cwd: options.workspaceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? LAKE_RUN_TIMEOUT_MS);
    let settled = false;
    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    }
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('close', (code) => {
      finish(() => resolve({ exitCode: code ?? -1, stdout, stderr }));
    });
  });
}
