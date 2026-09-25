/**
 * Subprocess wrappers for the `lake` commands invoked by `lean_project`.
 *
 * The VS Code Lean extension exposes these as command IDs; the direct adapter
 * has to run the real `lake` binary itself. We serialize per-workspace on an
 * in-process lane so two agents in the same TeXRA instance can't fire two
 * concurrent `lake build` invocations against the same `.lake/build`.
 */

import * as path from 'node:path';

import { Effect } from 'effect';

import { type PerKeyLane, withPerKeyLane } from '@utils/core/perKeyQueue';
import { executeCommand } from '@utils/system/execUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const LAKE_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LAKE_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
// The per-stream failure ceiling, explicit. capOutput() preserves successful
// chatty builds by retaining their last 4,194,304 characters, while this
// higher character cap decides when a command is stopped for excessive output.
const LAKE_PROCESS_MAX_BUFFER_CHARS = 100_000_000;

/**
 * One exclusive lane per workspace root. `withPerKeyLane` owns the entries:
 * it drops a root's lane once the last invocation holding or waiting on it
 * settles, so the map does not grow with every root visited.
 */
const workspaceLanes = new Map<string, PerKeyLane>();

function capOutput(output: string): string {
  if (output.length <= LAKE_MAX_OUTPUT_CHARS) return output;
  return (
    '…[output truncated]…\n' +
    output.slice(output.length - LAKE_MAX_OUTPUT_CHARS)
  );
}

interface LakeCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface LakeCommandOptions {
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
 * failing on non-zero exit so callers can decide how to format failures.
 */
export const runLakeCommand = (
  options: LakeCommandOptions,
): Effect.Effect<LakeCommandResult, never, ChildProcessSpawner> =>
  options.serialize
    ? // `path.resolve` stays inside the suspend: a relative `workspaceRoot`
      // resolves against the process cwd at run time, as it did before.
      Effect.suspend(() =>
        executeLake(options).pipe(
          withPerKeyLane(workspaceLanes, path.resolve(options.workspaceRoot)),
        ),
      )
    : executeLake(options);

function executeLake(
  options: LakeCommandOptions,
): Effect.Effect<LakeCommandResult, never, ChildProcessSpawner> {
  // Lake remains buffer-then-cap deliberately: preserving the current tail
  // result and complete exit diagnostics is simpler than duplicating bash's
  // head/tail streaming policy for this serialized, lower-risk path.
  //
  // The child is owned across interruption rather than abandoned. An
  // interrupt (a sibling root's `lease` failing under the unbounded
  // `Effect.forEach` in `leanServerPool.runLake`, or runtime disposal) must
  // not release this workspace's permit while `lake` is still writing
  // `.lake/build`: the next `build`/`clean` would then run concurrently with
  // an orphan, which is exactly what this module's lock exists to prevent.
  // `executeCommand` scopes the child inside this call, and that scope's
  // release terminates it and awaits its exit, so the lane is handed to the
  // next waiter only after the process is gone.
  return executeCommand([options.lakeCommand, ...options.args], {
    cwd: options.workspaceRoot,
    settings: undefined,
    timeout: options.timeoutMs ?? LAKE_RUN_TIMEOUT_MS,
    maxBuffer: LAKE_PROCESS_MAX_BUFFER_CHARS,
    quiet: true,
  }).pipe(
    Effect.map((result) => ({
      // A deadline, an output-limit trip, a spawn failure or a signal death
      // has no exit code of the command's own.
      exitCode:
        result.timedOut ||
        result.outputLimitExceeded === true ||
        result.noExitCode === true
          ? -1
          : result.exitCode,
      // executeCommand trims both ends of each stream, so leading
      // whitespace on lake's first line is not kept.
      stdout: capOutput(result.stdout),
      // A non-zero exit that printed nothing still tells the agent why the
      // command failed.
      stderr: capOutput(
        result.stderr ||
          (result.exitCode !== 0 && !result.stdout
            ? `lake exited with code ${result.exitCode}: ${[options.lakeCommand, ...options.args].join(' ')}`
            : ''),
      ),
    })),
  );
}
