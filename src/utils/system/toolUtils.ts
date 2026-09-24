// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, Option } from 'effect';
import { execa } from 'execa';
import { parse as shellParse } from 'shell-quote';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { ToolMissingReporter } from '@platform/interfaces';
import type { ExecResult } from '@shared/schemas';
import {
  PDFLATEX_INSTALL_GUIDE,
  LATEXDIFF_INSTALL_GUIDE,
  LATEXINDENT_INSTALL_GUIDE,
  TEXCOUNT_INSTALL_GUIDE,
  PERL_INSTALL_GUIDE,
  GHOSTSCRIPT_INSTALL_GUIDE,
  GRAPHICSMAGICK_INSTALL_GUIDE,
  IMAGEMAGICK_INSTALL_GUIDE,
  LATEXMK_INSTALL_GUIDE,
  TEXFMT_INSTALL_GUIDE,
  getInstallGuide,
} from '@shared/constants/latexToolchain';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { IS_WINDOWS, extendEnvPath, withExtendedPath } from './platformPaths';
import { resolveOptionalCommand } from './binaryResolver';
import { executeCommandSync } from './execCore';
import { executeCommand, type ExecuteCommandBaseOptions } from './execUtils';

const CHANNEL = 'toolUtils';

interface ToolConfig {
  command?: string | string[]; // Optional - defaults to "${toolName} --version"
  errorMessage: string;
  openDocsCommand?: string; // Optional command to open documentation
  label?: string; // Display name for missing-dependency lists; defaults to the id
}

/**
 * Hand the missing-tool message to the host. The reporter is the process's
 * optional `ToolMissingReporter` service; the composition root omits it where
 * no host UI exists, so an absent port reads as silence.
 */
function reportMissingTool(
  message: string,
  openDocsCommand?: string,
): Effect.Effect<void> {
  return Effect.serviceOption(ToolMissingReporter).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (report) => report(message, openDocsCommand),
      }),
    ),
  );
}

// Platform-specific install instructions resolved at module load.
// All guides are defined in @shared/constants/latex (single source of truth).
function installGuide(guide: Parameters<typeof getInstallGuide>[0]): string {
  return getInstallGuide(guide, process.platform);
}

const LATEXDIFF_INSTRUCTIONS = installGuide(LATEXDIFF_INSTALL_GUIDE);
const LATEXINDENT_INSTRUCTIONS = installGuide(LATEXINDENT_INSTALL_GUIDE);
const TEXFMT_INSTRUCTIONS = installGuide(TEXFMT_INSTALL_GUIDE);
const TEXCOUNT_INSTRUCTIONS = installGuide(TEXCOUNT_INSTALL_GUIDE);
const PERL_INSTRUCTIONS = installGuide(PERL_INSTALL_GUIDE);
const GHOSTSCRIPT_INSTRUCTIONS = installGuide(GHOSTSCRIPT_INSTALL_GUIDE);
const GM_INSTRUCTIONS = installGuide(GRAPHICSMAGICK_INSTALL_GUIDE);
const MAGICK_INSTRUCTIONS = installGuide(IMAGEMAGICK_INSTALL_GUIDE);
const PDFLATEX_INSTRUCTIONS = installGuide(PDFLATEX_INSTALL_GUIDE);
const LATEXMK_INSTRUCTIONS = installGuide(LATEXMK_INSTALL_GUIDE);

// Most tool entries share the same "open installation docs" link and the same
// "<tool> is not installed…" phrasing; only the label, install guide, and the
// occasional reason/command differ. These builders capture just that variance.
const INSTALL_DOCS = 'texra.openDoc,installation';

function featureTool(name: string, guide: string): string {
  return `${name} is not installed. Please install it to use this feature.\n${guide}`;
}

function texTool(name: string, guide: string): string {
  return `${name} is not installed. Please install a TeX distribution to use this feature.\n${guide}`;
}

/** Build a ToolConfig with the default install-docs link unless `docs: false`. */
function withDocs(
  errorMessage: string,
  extra: { command?: string | string[]; docs?: false; label?: string } = {},
): ToolConfig {
  return {
    errorMessage,
    ...(extra.command ? { command: extra.command } : {}),
    ...(extra.docs === false ? {} : { openDocsCommand: INSTALL_DOCS }),
    ...(extra.label ? { label: extra.label } : {}),
  };
}

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  // ImageMagick / GraphicsMagick / system dependencies
  magick: withDocs(
    'ImageMagick is not installed. Please install ImageMagick to use PDF to PNG conversion.\n' +
      MAGICK_INSTRUCTIONS,
    { label: 'ImageMagick' },
  ),
  gm: withDocs(
    'GraphicsMagick is not installed. Please install GraphicsMagick to use PDF to PNG conversion.\n' +
      GM_INSTRUCTIONS,
    { command: 'gm version', label: 'GraphicsMagick' },
  ),
  perl: withDocs(
    'Perl is not installed. latexindent requires Perl.\n' + PERL_INSTRUCTIONS,
    { command: 'perl --version' },
  ),
  gs: withDocs(
    'Ghostscript is not installed. Please install Ghostscript to use PDF to PNG conversion.\n' +
      GHOSTSCRIPT_INSTRUCTIONS,
    {
      command: IS_WINDOWS
        ? ['gswin64c --version', 'gswin32c --version', 'gs --version']
        : 'gs --version',
    },
  ),
  // Probe only: the wolfram plugin's manifest entry owns the install copy.
  wolframscript: withDocs(
    '"wolframscript" is not installed or not in your PATH.',
    { command: 'wolframscript -version', docs: false },
  ),

  // LaTeX tools
  latexdiff: withDocs(featureTool('latexdiff', LATEXDIFF_INSTRUCTIONS)),
  'latexdiff-vc': withDocs(featureTool('latexdiff-vc', LATEXDIFF_INSTRUCTIONS)),
  latexindent: withDocs(featureTool('latexindent', LATEXINDENT_INSTRUCTIONS)),
  'tex-fmt': withDocs(featureTool('tex-fmt', TEXFMT_INSTRUCTIONS)),
  texcount: withDocs(featureTool('texcount', TEXCOUNT_INSTRUCTIONS)),
  latexmk: withDocs(featureTool('latexmk', LATEXMK_INSTRUCTIONS)),
  pdflatex: withDocs(featureTool('pdflatex', PDFLATEX_INSTRUCTIONS)),
  xelatex: withDocs(texTool('xelatex', PDFLATEX_INSTRUCTIONS)),
  lualatex: withDocs(texTool('lualatex', PDFLATEX_INSTRUCTIONS)),
  bibtex: withDocs(texTool('bibtex', PDFLATEX_INSTRUCTIONS)),
  biber: withDocs(texTool('biber', PDFLATEX_INSTRUCTIONS)),
};

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
 * Spawn one `<tool> --version` probe. This is the module's execa edge, lifted
 * exactly once: `Effect.tryPromise` hands the thunk an `AbortSignal` that
 * aborts when the fiber is interrupted, and it is execa's `cancelSignal`, so
 * an interrupted probe kills the spawned process instead of leaving it to run
 * out its five-second timeout. No caller threads a signal in.
 */
const spawnProbe = (cmd: string, args: string[], execEnv: NodeJS.ProcessEnv) =>
  Effect.tryPromise({
    try: (signal) =>
      execa(cmd, args, {
        env: execEnv,
        reject: false,
        timeout: 5000,
        cancelSignal: signal,
      }),
    catch: ensureError,
  });

/**
 * Probe one command, falling back to a common-paths-resolved path when the
 * direct spawn neither exits 0 nor prints version-like output.
 */
const executeWithFallback = Effect.fn('toolUtils.executeWithFallback')(
  function* (
    cmd: string,
    args: string[],
    execEnv: NodeJS.ProcessEnv,
  ): Effect.fn.Return<boolean, Error> {
    yield* Effect.logDebug(
      `Checking tool '${cmd}' with args [${args.join(', ')}]`,
    ).pipe(withLogChannel(CHANNEL));

    let result = yield* spawnProbe(cmd, args, execEnv);
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

    const fallback = resolveOptionalCommand(cmd, args);
    yield* Effect.logDebug(
      `Fallback search for '${cmd}': ${fallback?.resolvedPath ?? 'not found'}`,
    ).pipe(withLogChannel(CHANNEL));

    if (fallback) {
      yield* Effect.logDebug(
        `Running fallback '${fallback.command}' with args [${fallback.args.join(', ')}]`,
      ).pipe(withLogChannel(CHANNEL));
      result = yield* spawnProbe(fallback.command, fallback.args, execEnv);
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

/**
 * Whether a tool is installed.
 *
 * @param toolName Tool name (looked up in TOOL_CONFIGS)
 * @param showError Whether to report a missing tool through the host handler
 *
 * The spawned `<tool> --version` probes are cancelled by the fiber's own
 * interruption, so no caller threads an `AbortSignal` in. An interrupted probe
 * never reaches the report below either: interruption unwinds the fiber, which
 * is what the old `signal.aborted` guard hand-rolled — stopping a run must not
 * raise an install prompt or open the setup docs.
 *
 * The probe's own failure is answered, not raised: the user-facing message is
 * the tool's install guidance either way, so the cause is logged and the tool
 * reports as absent. That leaves no error channel for callers to handle.
 */
export const checkToolInstalled = Effect.fn('toolUtils.checkToolInstalled')(
  function* (
    toolName: string,
    showError: boolean = true,
  ): Effect.fn.Return<boolean> {
    const config = TOOL_CONFIGS[toolName];

    if (!config) {
      if (showError) {
        yield* reportMissingTool(`Unknown tool: ${toolName}`);
      }
      return false;
    }

    // Generate default command if not specified
    const command = config.command || `${toolName} --version`;

    const probe = Effect.gen(function* () {
      const execEnv = withExtendedPath(process.env);
      const extendedPath = extendEnvPath();

      // Log PATH info once (not per-command)
      yield* Effect.logDebug(
        `PATH contains ${extendedPath.split(path.delimiter).length} entries, ` +
          `includes /usr/bin: ${extendedPath.includes('/usr/bin')}`,
      ).pipe(withLogChannel(CHANNEL));

      if (Array.isArray(command)) {
        // Try each command in the array until one succeeds
        for (const cmd of command) {
          const parsed = parseCommand(cmd);
          if (!parsed) continue;
          if (
            yield* executeWithFallback(parsed.cmdName, parsed.args, execEnv)
          ) {
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
      return yield* executeWithFallback(parsed.cmdName, parsed.args, execEnv);
    });

    // A probe failure and an absent tool differ only in what the report links
    // to: the failing path has no install-docs command, exactly as before.
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
    const outcome = yield* probe.pipe(
      Effect.map((installed) => ({ installed, probeFailed: false })),
      Effect.catch(answerAsAbsent),
      Effect.catchDefect(answerAsAbsent),
    );

    if (!outcome.installed && showError) {
      yield* reportMissingTool(
        config.errorMessage,
        outcome.probeFailed ? undefined : config.openDocsCommand,
      );
    }

    return outcome.installed;
  },
);

/**
 * Options for runToolWithCheck function (internal to this module).
 *
 * `signal` is not among them: both the preflight probe and the run itself are
 * cancelled by the fiber's interruption, so there is nothing for a caller to
 * thread through.
 */
type RunToolOptions = {
  /** Whether to show error messages for missing tools */
  showError?: boolean;
} & Omit<ExecuteCommandBaseOptions, 'signal'>;

/**
 * Run a tool after verifying it is installed, answering `false` when the tool
 * is missing.
 *
 * Interruption tears the spawned process down: `executeCommand` is an Effect
 * whose own finalizer terminates the child, so there is nothing to thread.
 */
export const runToolWithCheck = Effect.fn('toolUtils.runToolWithCheck')(
  function* (
    toolName: string,
    args: string[],
    options: RunToolOptions,
  ): Effect.fn.Return<ExecResult | false, Error> {
    const { showError = true, ...execOptions } = options;
    if (!(yield* checkToolInstalled(toolName, showError))) {
      return false;
    }
    return yield* executeCommand([toolName, ...args], execOptions);
  },
);

/**
 * Which of the two interchangeable image processors is installed, preferring
 * ImageMagick, or `null` when neither is. The single owner of the
 * "magick or gm" alternation that PDF rasterization, image resizing, and the
 * core-dependency check all decide on.
 */
export const detectImageTool = Effect.fn('toolUtils.detectImageTool')(
  function* (): Effect.fn.Return<'magick' | 'gm' | null> {
    const [hasMagick, hasGm] = yield* Effect.all(
      ['magick', 'gm'].map((tool) => checkToolInstalled(tool, false)),
      { concurrency: 'unbounded' },
    );
    if (hasMagick) return 'magick';
    if (hasGm) return 'gm';
    return null;
  },
);

/**
 * Get the documentation command for a given tool.
 * @param tool Tool identifier
 * @returns Command string or undefined if not available
 */
export function getToolDocsCommand(tool: string): string | undefined {
  return TOOL_CONFIGS[tool]?.openDocsCommand;
}

/** Display label for `id` from TOOL_CONFIGS, defaulting to the id itself. */
export function toolLabel(id: string): string {
  return TOOL_CONFIGS[id]?.label ?? id;
}

/** Reports the neither-GraphicsMagick-nor-ImageMagick error through the host handler. */
export function reportMissingImageTools(): Effect.Effect<void> {
  const errorMsg =
    'Neither GraphicsMagick nor ImageMagick is installed. Please install either tool for image processing.\n' +
    'GraphicsMagick:\n' +
    GM_INSTRUCTIONS +
    '\n\nOR\n\nImageMagick:\n' +
    MAGICK_INSTRUCTIONS;
  return reportMissingTool(errorMsg, INSTALL_DOCS);
}

/** Package managers TeXRA knows how to install dependencies with. */
export const SYSTEM_PACKAGE_MANAGERS = ['brew', 'apt', 'scoop'] as const;

export type SystemPackageManager = (typeof SYSTEM_PACKAGE_MANAGERS)[number];

// Platform-aware probe order: check the platform's native PM first so that
// cross-platform installs (e.g. Linuxbrew on Linux) don't shadow the PM that
// DEPENDENCY_INSTALL_COMMANDS actually uses for that platform.
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
 * once and cached, including misses. The answer is the whole report: the
 * probe's own run and stderr are logged by `executeCommandSync`, and each
 * caller surfaces the boolean (or `detectPackageManager`'s null) itself.
 */
export function hasPackageManager(name: SystemPackageManager): boolean {
  const cached = packageManagerAvailability.get(name);
  if (cached !== undefined) return cached;

  // A `--version` probe answers the same from any directory and for any
  // project, so it names the process cwd and no setting slots instead of
  // reaching for a workspace it does not need.
  const available = executeCommandSync([name, '--version'], {
    cwd: process.cwd(),
  }).success;
  packageManagerAvailability.set(name, available);
  return available;
}
