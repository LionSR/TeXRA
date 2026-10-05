/**
 * Whether a command-line tool is installed: one probe that runs its version
 * command (falling back to a common-paths lookup), and the image processor
 * that PDF rasterization and image resizing pick.
 * Which tools an app needs, and how it tells the user to install a missing
 * one, are the app's own table (TeXRA's: `@texra/utils/system/toolChecks`).
 */

// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { parse as shellParse } from 'shell-quote';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { extendEnvPath } from './platformPaths';
import { resolveOptionalCommand } from './binaryResolver';
import { executeCommand } from './execUtils';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'toolUtils';

/** Whether a probe result carries a version-like pattern (e.g., "3.7.1"). */
function hasVersionOutput(result: { stdout: string; stderr: string }): boolean {
  return /\d+\.\d+/.test(result.stdout) || /\d+\.\d+/.test(result.stderr);
}

/** Split a probe command string into an executable and its arguments. */
function parseCommand(cmd: string): { cmdName: string; args: string[] } | null {
  const parts = shellParse(cmd).filter(
    (arg): arg is string => typeof arg === 'string',
  );
  if (parts.length === 0) return null;
  const [cmdName, ...args] = parts;
  return { cmdName, args };
}

/**
 * Run one `<tool> --version` probe. A `--version` probe answers the same from
 * any directory and for any project, so it names the process cwd and no
 * setting slots. An interrupted probe's scope kills the child.
 */
const runProbe = (cmd: string, args: string[]) =>
  executeCommand([cmd, ...args], {
    cwd: process.cwd(),
    settings: undefined,
    timeout: 5000,
    quiet: true,
  });

/**
 * Probe one command, falling back to a common-paths-resolved path when the
 * direct spawn neither exits 0 nor prints version-like output.
 */
const executeWithFallback = Effect.fn('toolUtils.executeWithFallback')(
  function* (
    cmd: string,
    args: string[],
  ): Effect.fn.Return<boolean, never, ChildProcessSpawner> {
    yield* Effect.logDebug(
      `Checking tool '${cmd}' with args [${args.join(', ')}]`,
    ).pipe(withLogChannel(CHANNEL));

    let result = yield* runProbe(cmd, args);
    yield* Effect.logDebug(
      `Initial check for '${cmd}': exitCode=${result.exitCode}, ` +
        `stdout=${result.stdout?.slice(0, 100) || '(empty)'}, ` +
        `stderr=${result.stderr?.slice(0, 100) || '(empty)'}`,
    ).pipe(withLogChannel(CHANNEL));

    // Accept if exit code is 0, OR if we got version-like output
    // (some tools return non-zero for --version but still output version info)
    if (result.exitCode === 0 || hasVersionOutput(result)) {
      yield* Effect.logDebug(`Tool '${cmd}' detected successfully`).pipe(
        withLogChannel(CHANNEL),
      );
      return true;
    }

    const fallback = yield* resolveOptionalCommand(cmd, args);
    yield* Effect.logDebug(
      `Fallback search for '${cmd}': ${fallback?.resolvedPath ?? 'not found'}`,
    ).pipe(withLogChannel(CHANNEL));

    if (fallback) {
      yield* Effect.logDebug(
        `Running fallback '${fallback.command}' with args [${fallback.args.join(', ')}]`,
      ).pipe(withLogChannel(CHANNEL));
      result = yield* runProbe(fallback.command, fallback.args);
      yield* Effect.logDebug(
        `Fallback result: exitCode=${result.exitCode}, ` +
          `stdout=${result.stdout?.slice(0, 100) || '(empty)'}, ` +
          `stderr=${result.stderr?.slice(0, 100) || '(empty)'}`,
      ).pipe(withLogChannel(CHANNEL));

      if (result.exitCode === 0 || hasVersionOutput(result)) {
        return true;
      }
    }

    // Log at info level so it shows in output channel by default
    yield* Effect.logInfo(
      `Tool '${cmd}' not detected. Last result: exitCode=${result.exitCode}, ` +
        `stdout=${result.stdout?.slice(0, 200) || '(empty)'}, ` +
        `stderr=${result.stderr?.slice(0, 200) || '(empty)'}`,
    ).pipe(withLogChannel(CHANNEL));
    return false;
  },
);

/** What a probe found: whether the tool answered, and whether the probe
 *  itself failed rather than finding nothing. */
interface ToolProbe {
  readonly installed: boolean;
  readonly probeFailed: boolean;
}

/**
 * Probe `toolName` with `command` (by default `<toolName> --version`), or
 * with each of several commands in turn until one answers.
 *
 * The spawned probes are cancelled by the fiber's own interruption, so no
 * caller threads an `AbortSignal` in. The probe's own failure is answered,
 * not raised: the cause is logged and the tool reads as absent with
 * `probeFailed` set, which leaves no error channel for callers to handle.
 */
export const probeTool = Effect.fn('toolUtils.probeTool')(function* (
  toolName: string,
  command: string | readonly string[] = `${toolName} --version`,
): Effect.fn.Return<ToolProbe, never, ChildProcessSpawner> {
  const probe = Effect.gen(function* () {
    const extendedPath = extendEnvPath();

    // Log PATH info once (not per-command)
    yield* Effect.logDebug(
      `PATH contains ${extendedPath.split(path.delimiter).length} entries, ` +
        `includes /usr/bin: ${extendedPath.includes('/usr/bin')}`,
    ).pipe(withLogChannel(CHANNEL));

    if (typeof command !== 'string') {
      // Try each command in the array until one succeeds
      for (const cmd of command) {
        const parsed = parseCommand(cmd);
        if (!parsed) continue;
        if (yield* executeWithFallback(parsed.cmdName, parsed.args)) {
          return true;
        }
      }
      return false;
    }

    // Single command: validate first, then execute
    const parsed = parseCommand(command);
    if (!parsed) {
      return yield* Effect.fail(
        new Error('Invalid command: no executable found'),
      );
    }
    return yield* executeWithFallback(parsed.cmdName, parsed.args);
  });

  // A probe failure reads as an absent tool, marked: a caller that reports
  // the absence links no install docs for a probe that never answered.
  const answerAsAbsent = (err: unknown) =>
    Effect.logWarning(
      `Tool check for '${toolName}' failed: ${toErrorMessage(err)}`,
    ).pipe(
      withLogChannel(CHANNEL),
      Effect.as({ installed: false, probeFailed: true }),
    );

  // Both arms, because the `try`/`catch` this replaces answered a rejected
  // spawn and a synchronous throw alike — the binary resolution and the PATH
  // build sit inside the probe and are ordinary code that can throw, and a
  // throw there means "not detected", not a crashed run. Interruption is
  // neither a failure nor a defect, so it still unwinds the fiber instead of
  // reporting a missing tool.
  return yield* probe.pipe(
    Effect.map((installed) => ({ installed, probeFailed: false })),
    Effect.catch((error: Error) => answerAsAbsent(error)),
    Effect.catchDefect(answerAsAbsent),
  );
});

/** The version command of each image processor: GraphicsMagick has no
 *  `--version` flag. */
export const IMAGE_TOOL_COMMANDS = {
  magick: 'magick --version',
  gm: 'gm version',
} as const;

/**
 * Which of the two interchangeable image processors is installed, preferring
 * ImageMagick, or `null` when neither is. The single owner of the
 * "magick or gm" alternation that PDF rasterization, image resizing, and the
 * core-dependency check all decide on.
 */
export const detectImageTool = Effect.fn('toolUtils.detectImageTool')(
  function* (): Effect.fn.Return<
    'magick' | 'gm' | null,
    never,
    ChildProcessSpawner
  > {
    const [hasMagick, hasGm] = yield* Effect.all(
      (['magick', 'gm'] as const).map((tool) =>
        Effect.map(
          probeTool(tool, IMAGE_TOOL_COMMANDS[tool]),
          ({ installed }) => installed,
        ),
      ),
      { concurrency: 'unbounded' },
    );
    if (hasMagick) return 'magick';
    if (hasGm) return 'gm';
    return null;
  },
);
