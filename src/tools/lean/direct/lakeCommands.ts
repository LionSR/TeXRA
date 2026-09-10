/**
 * Subprocess wrappers for the `lake` commands invoked by `lean_project`.
 *
 * The VS Code Lean extension exposes these as command IDs; the direct adapter
 * has to run the real `lake` binary itself. We serialize per-workspace via an
 * in-process semaphore so two agents in the same TeXRA instance can't fire two
 * concurrent `lake build` invocations against the same `.lake/build`.
 */

import * as path from 'node:path';

import { Effect, Semaphore } from 'effect';
import { execa } from 'execa';

import { deriveCommandStderr } from '@utils/system/execUtils';

const LAKE_RUN_TIMEOUT_MS = 10 * 60 * 1000;
const LAKE_MAX_OUTPUT_CHARS = 4 * 1024 * 1024;
// Keep execa 10's current per-stream failure ceiling explicit. capOutput()
// preserves successful chatty builds by retaining their last 4,194,304 characters, while
// this higher character cap prevents a dependency-default change from silently
// changing when a command is terminated for excessive output.
const LAKE_PROCESS_MAX_BUFFER_CHARS = 100_000_000;

/**
 * One single-permit semaphore per workspace root. `users` counts the
 * invocations holding or waiting on it so the entry can be dropped once the
 * workspace goes idle, keeping the map from growing with every root visited.
 */
const workspaceLocks = new Map<
  string,
  { readonly semaphore: Semaphore.Semaphore; users: number }
>();

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
): Effect.Effect<LakeCommandResult> =>
  options.serialize
    ? serializeOnWorkspace(options.workspaceRoot, executeLake(options))
    : executeLake(options);

function serializeOnWorkspace(
  workspaceRoot: string,
  work: Effect.Effect<LakeCommandResult>,
): Effect.Effect<LakeCommandResult> {
  return Effect.suspend(() => {
    const workspaceKey = path.resolve(workspaceRoot);
    const lock = workspaceLocks.get(workspaceKey) ?? {
      semaphore: Semaphore.makeUnsafe(1),
      users: 0,
    };
    workspaceLocks.set(workspaceKey, lock);
    lock.users += 1;
    return lock.semaphore.withPermit(work).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          lock.users -= 1;
          if (lock.users === 0 && workspaceLocks.get(workspaceKey) === lock) {
            workspaceLocks.delete(workspaceKey);
          }
        }),
      ),
    );
  });
}

/** The raw `lake` spawn, split out so its exact execa result type stays
 *  inferred rather than widened by the generic `Result`. */
function spawnLake(options: LakeCommandOptions) {
  return execa(options.lakeCommand, [...options.args], {
    cwd: options.workspaceRoot,
    timeout: options.timeoutMs ?? LAKE_RUN_TIMEOUT_MS,
    reject: false,
    maxBuffer: LAKE_PROCESS_MAX_BUFFER_CHARS,
    windowsHide: true,
    stdin: 'ignore',
  });
}

type LakeExecaResult = Awaited<ReturnType<typeof spawnLake>>;

function executeLake(
  options: LakeCommandOptions,
): Effect.Effect<LakeCommandResult> {
  // Lake remains buffer-then-cap deliberately: preserving the current tail
  // result and complete exit diagnostics is simpler than duplicating bash's
  // head/tail streaming policy for this serialized, lower-risk path.
  //
  // `reject: false` means execa settles on a failed command rather than
  // rejecting, so the failure channel stays empty here — as the Promise
  // contract this replaces did; a genuine spawn error is still a defect.
  //
  // The child is owned across interruption rather than abandoned. An
  // interrupt (a sibling root's `lease` failing under the unbounded
  // `Effect.forEach` in `leanServerPool.runLake`, or runtime disposal) must
  // not release this workspace's permit while `lake` is still writing
  // `.lake/build`: the next `build`/`clean` would then run concurrently with
  // an orphan, which is exactly what this module's lock exists to prevent.
  // The returned canceller terminates the child and awaits its exit, and the
  // interrupt only propagates once that finishes — so `withPermit` and the
  // `users` bookkeeping in `serializeOnWorkspace` release after the process
  // is gone. A bare abort signal is not enough: Effect aborts the controller
  // but does not wait for the abortee.
  return Effect.callback<LakeExecaResult>((resume) => {
    const child = spawnLake(options);
    child.then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) => resume(Effect.die(error)),
    );
    // `Effect.exit` absorbs however the child settles — including a spawn
    // rejection — without a raw catch clause, which this file may not carry.
    return Effect.asVoid(
      Effect.exit(
        Effect.promise(() => {
          child.kill();
          return child;
        }),
      ),
    );
  }).pipe(
    Effect.map((result) => {
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
    }),
  );
}
