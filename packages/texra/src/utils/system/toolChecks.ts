/**
 * Running TeXRA's LaTeX and image tools: the missing-tool error, the version
 * probe the status surfaces report, and the runner every tool call goes
 * through. What each tool is, how it answers a probe and how to install it is
 * the catalog's (`@texra/shared/constants/latexToolchain`).
 */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import { toErrorMessage } from '@texra-ai/harness/schemas';
import {
  executeCommand,
  type ExecuteCommandBaseOptions,
  whichOnExtendedPath,
  type ExecResult,
} from '@texra-ai/harness/node';
import { commandDirs } from '@texra/platform/defaults/commandDirs';
import { findCommand } from '@texra/utils/system/binaryResolver';
import {
  installAdvice,
  LATEX_TOOL_ENTRIES,
  normalizePlatform,
  SYSTEM_PACKAGE_MANAGERS,
  type LatexToolName,
  type SystemPackageManager,
} from '@texra/shared/constants/latexToolchain';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * A tool a call needs is not installed: its name and this platform's install
 * steps. The caller that owns the user-facing message shows it (a command's
 * error report, a tool result, a skipped check's reason).
 */
export class ToolMissing extends Schema.TaggedError<ToolMissing>()(
  'ToolMissing',
  { tool: Schema.String, guide: Schema.String },
) {
  override get message(): string {
    return `${this.tool} is not installed.\n${this.guide}`;
  }
}

/** Whether a probe answered: exit 0, or version-like output (some tools
 *  exit non-zero for their version flag but still print it). */
function answered(result: ExecResult): boolean {
  return (
    result.exitCode === 0 ||
    /\d+\.\d+/.test(result.stdout) ||
    /\d+\.\d+/.test(result.stderr)
  );
}

/**
 * Run one version probe. A probe answers the same from any directory and for
 * any project, so it names the process cwd and no setting slots. An
 * interrupted probe's scope kills the child.
 */
const runProbe = (cmd: string, args: readonly string[]) =>
  executeCommand([cmd, ...args], {
    cwd: process.cwd(),
    settings: undefined,
    timeout: 5000,
    quiet: true,
  });

/**
 * Whether `tool` answers the version probe `args`, spawned directly or at the
 * path `findCommand` resolves. Every call spawns, so a status surface reports
 * what is installed now. A catalog tool is probed through {@link probeTool};
 * a plugin's binary outside the catalog (`wolframscript`) names its own
 * arguments.
 *
 * A probe that dies (the binary resolution and the PATH build are ordinary
 * code) answers `false`, logged at warn. Interruption is not a defect, so it
 * still unwinds the fiber and kills the spawned probe.
 */
export const probeCommand = Effect.fn('toolChecks.probeCommand')(function* (
  tool: string,
  args: readonly string[],
): Effect.fn.Return<boolean, never, ChildProcessSpawner> {
  return yield* Effect.gen(function* () {
    let result = yield* runProbe(tool, args);
    if (answered(result)) return true;
    const fallback = yield* findCommand(tool);
    if (fallback) {
      result = yield* runProbe(fallback.command, [...fallback.args, ...args]);
      if (answered(result)) return true;
    }
    yield* Effect.logInfo(
      `Tool '${tool}' not detected. Last result: exitCode=${result.exitCode}, ` +
        `stdout=${result.stdout.slice(0, 200) || '(empty)'}, ` +
        `stderr=${result.stderr.slice(0, 200) || '(empty)'}`,
    );
    return false;
  }).pipe(
    Effect.catchDefect((err) =>
      Effect.logWarning(
        `Tool check for '${tool}' failed: ${toErrorMessage(err)}`,
      ).pipe(Effect.as(false)),
    ),
    withLogChannel('toolUtils'),
  );
});

/**
 * Whether a catalog tool answers its version probe, under its name or one of
 * its `alternates`: what the status surfaces (the doctor, the setup
 * assistant, the settings view, the dependency banner) report.
 */
export const probeTool = Effect.fn('toolChecks.probeTool')(function* (
  tool: LatexToolName,
): Effect.fn.Return<boolean, never, ChildProcessSpawner> {
  const { versionArgs = ['--version'], alternates = [] } =
    LATEX_TOOL_ENTRIES[tool];
  for (const command of [tool, ...alternates]) {
    if (yield* probeCommand(command, versionArgs)) return true;
  }
  return false;
});

/**
 * Run a catalog tool. No probe precedes the run, so an installed tool costs
 * one spawn and nothing is cached. A run that could not start (the result
 * `executeCommand` reports with code 127 and no exit code of its own) is
 * asked the version probe: a tool that does not answer fails with
 * {@link ToolMissing}; one that does returns the failed run's result.
 *
 * Interruption tears the spawned process down: `executeCommand` is an Effect
 * whose own finalizer terminates the child, so there is nothing to thread.
 */
export const runTool = Effect.fn('toolChecks.runTool')(function* (
  tool: LatexToolName,
  args: readonly string[],
  options: ExecuteCommandBaseOptions,
): Effect.fn.Return<ExecResult, ToolMissing, ChildProcessSpawner> {
  const result = yield* executeCommand([tool, ...args], options);
  if (
    result.noExitCode === true &&
    result.exitCode === 127 &&
    !(yield* probeTool(tool))
  ) {
    return yield* new ToolMissing({
      tool,
      guide: installAdvice(tool, [tool], normalizePlatform(process.platform))
        .guide,
    });
  }
  return result;
});

// Platform-aware probe order: check the platform's native PM first so that
// cross-platform installs (e.g. Linuxbrew on Linux) don't shadow the PM that
// the install advice uses for that platform.
const PREFERRED_PACKAGE_MANAGER: Readonly<
  Partial<Record<NodeJS.Platform, SystemPackageManager>>
> = Object.freeze({ darwin: 'brew', linux: 'apt', win32: 'scoop' });

/**
 * Detect the first available package manager on the system.
 * Returns 'brew', 'apt', 'scoop', or null if none found. Each answer comes
 * from {@link hasPackageManager}, which owns the probe cache.
 */
export function detectPackageManager(): SystemPackageManager | null {
  const first = PREFERRED_PACKAGE_MANAGER[process.platform];
  const managers = first
    ? [first, ...SYSTEM_PACKAGE_MANAGERS.filter((name) => name !== first)]
    : SYSTEM_PACKAGE_MANAGERS;

  for (const name of managers) {
    if (hasPackageManager(name)) return name;
  }
  return null;
}

const packageManagerAvailability = new Map<SystemPackageManager, boolean>();

/**
 * Whether one specific package manager is installed.
 *
 * Callers that only have an install command for some managers need this rather
 * than {@link detectPackageManager}: that one answers "which manager does this
 * platform use", so on a Linux box with both apt and Linuxbrew it returns
 * `apt` and a brew-only command map would never match. Each answer is probed
 * once and cached, including misses. The answer is a PATH lookup, not a
 * spawn, so it stays synchronous for the install-command getters; a present
 * but broken binary counts as installed, and the install command it picks
 * then fails visibly. Each caller surfaces the boolean (or
 * `detectPackageManager`'s null) itself.
 */
export function hasPackageManager(name: SystemPackageManager): boolean {
  const cached = packageManagerAvailability.get(name);
  if (cached !== undefined) return cached;

  const available = whichOnExtendedPath(name, commandDirs()) !== null;
  packageManagerAvailability.set(name, available);
  return available;
}
