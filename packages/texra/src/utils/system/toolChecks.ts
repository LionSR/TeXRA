/**
 * TeXRA's required tools: each one's version command, the message that tells
 * the user how to install it (the install guides of the LaTeX toolchain
 * table), and the checks that hand a missing one to the host. The probe
 * itself is the harness's (`probeTool`).
 */

// Third-party imports
import { Effect, Option } from 'effect';

// Local imports
import { ToolMissingReporter } from '@texra-ai/harness';
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
} from '@texra/shared/constants/latexToolchain';
import {
  executeCommand,
  type ExecuteCommandBaseOptions,
} from '@utils/system/execUtils';
import { IS_WINDOWS, whichOnExtendedPath } from '@utils/system/platformPaths';
import { IMAGE_TOOL_COMMANDS, probeTool } from '@utils/system/toolUtils';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

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
    { command: IMAGE_TOOL_COMMANDS.gm, label: 'GraphicsMagick' },
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
export const checkToolInstalled = Effect.fn('toolChecks.checkToolInstalled')(
  function* (
    toolName: string,
    showError: boolean = true,
  ): Effect.fn.Return<boolean, never, ChildProcessSpawner> {
    const config = TOOL_CONFIGS[toolName];

    if (!config) {
      if (showError) {
        yield* reportMissingTool(`Unknown tool: ${toolName}`);
      }
      return false;
    }

    const outcome = yield* probeTool(toolName, config.command);
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
export const runToolWithCheck = Effect.fn('toolChecks.runToolWithCheck')(
  function* (
    toolName: string,
    args: string[],
    options: RunToolOptions,
  ): Effect.fn.Return<ExecResult | false, never, ChildProcessSpawner> {
    const { showError = true, ...execOptions } = options;
    if (!(yield* checkToolInstalled(toolName, showError))) {
      return false;
    }
    return yield* executeCommand([toolName, ...args], execOptions);
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
 * once and cached, including misses. The answer is a PATH lookup, not a
 * spawn, so it stays synchronous for the install-command getters; a present
 * but broken binary counts as installed, and the install command it picks
 * then fails visibly. Each caller surfaces the boolean (or
 * `detectPackageManager`'s null) itself.
 */
export function hasPackageManager(name: SystemPackageManager): boolean {
  const cached = packageManagerAvailability.get(name);
  if (cached !== undefined) return cached;

  const available = whichOnExtendedPath(name) !== null;
  packageManagerAvailability.set(name, available);
  return available;
}
