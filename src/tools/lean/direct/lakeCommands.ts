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

const LAKE_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LAKE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const workspaceMutexes = new Map<string, Promise<unknown>>();

function appendCapped(existing: string, chunk: string): string {
  const combined = existing + chunk;
  if (combined.length <= LAKE_MAX_OUTPUT_BYTES) return combined;
  return (
    '…[output truncated]…\n' +
    combined.slice(combined.length - LAKE_MAX_OUTPUT_BYTES)
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
  const workspaceKey = path.resolve(options.workspaceRoot);
  if (!options.serialize) {
    return executeLake(options);
  }
  const prior = workspaceMutexes.get(workspaceKey) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(() => executeLake(options));
  // Use a finally hook so we always clear ourselves out, even on rejection.
  workspaceMutexes.set(workspaceKey, next);
  try {
    return await next;
  } finally {
    if (workspaceMutexes.get(workspaceKey) === next) {
      workspaceMutexes.delete(workspaceKey);
    }
  }
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
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}
