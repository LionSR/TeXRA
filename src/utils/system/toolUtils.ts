// Node imports
import * as path from 'node:path';

// Third-party imports
import { execa } from 'execa';
import { parse as shellParse } from 'shell-quote';

// Local imports
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
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
  WOLFRAM_INSTALL_GUIDE,
  PANDOC_INSTALL_GUIDE,
  getInstallGuide,
} from '@shared/constants/latexToolchain';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local file imports
import { IS_WINDOWS, extendEnvPath } from './platformPaths';
import { BinaryResolver } from './binaryResolver';
import {
  executeCommand,
  executeCommandSync,
  type ExecuteCommandBaseOptions,
} from './execUtils';

const log = createLog('toolUtils');

interface ToolConfig {
  command?: string | string[]; // Optional - defaults to "${toolName} --version"
  errorMessage: string;
  openDocsCommand?: string; // Optional command to open documentation
}

async function reportMissingTool(
  message: string,
  openDocsCommand?: string,
): Promise<void> {
  try {
    await platform().toolMissingHandler?.(message, openDocsCommand);
  } catch (err) {
    log.error(`Failed to report missing tool: ${toErrorMessage(err)}`);
  }
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
const WOLFRAM_INSTRUCTIONS = installGuide(WOLFRAM_INSTALL_GUIDE);
const PANDOC_INSTRUCTIONS = installGuide(PANDOC_INSTALL_GUIDE);
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
  extra: { command?: string | string[]; docs?: false } = {},
): ToolConfig {
  return {
    errorMessage,
    ...(extra.command ? { command: extra.command } : {}),
    ...(extra.docs === false ? {} : { openDocsCommand: INSTALL_DOCS }),
  };
}

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  // ImageMagick / GraphicsMagick / system dependencies
  magick: withDocs(
    'ImageMagick is not installed. Please install ImageMagick to use PDF to PNG conversion.\n' +
      MAGICK_INSTRUCTIONS,
  ),
  gm: withDocs(
    'GraphicsMagick is not installed. Please install GraphicsMagick to use PDF to PNG conversion.\n' +
      GM_INSTRUCTIONS,
    { command: 'gm version' },
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
  wolframscript: withDocs(
    '"wolframscript" is not installed or not in your PATH.\n' +
      WOLFRAM_INSTRUCTIONS,
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

  // Document conversion tools
  pandoc: withDocs(featureTool('pandoc', PANDOC_INSTRUCTIONS), { docs: false }),

  // TeXRA's own CLI entrypoints
  texra: withDocs('TeXRA CLI is not installed or not on PATH.', {
    docs: false,
  }),
  'texra-local': withDocs('TeXRA local CLI is not installed or not on PATH.', {
    docs: false,
  }),
};

/**
 * Run a probe command, returning its result or null when the spawn itself
 * throws (missing binary, permission error). `reject: false` means non-zero
 * exit codes still resolve, so only a real spawn failure lands here. `label`
 * distinguishes the primary probe from a fallback one in the log line. The
 * inline `reject: false` literal keeps execa's overload resolving `stdout`/
 * `stderr` to strings.
 */
async function tryExeca(
  cmd: string,
  args: string[],
  label: string,
  env: NodeJS.ProcessEnv,
) {
  try {
    return await execa(cmd, args, { env, reject: false, timeout: 5000 });
  } catch (execErr) {
    log.info(
      `Exception executing ${label}'${cmd}': ${toErrorMessage(execErr)}`,
    );
    return null;
  }
}

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
 * Probe one command, falling back to a BinaryResolver-resolved path when the
 * direct spawn neither exits 0 nor prints version-like output.
 */
async function executeWithFallback(
  cmd: string,
  args: string[],
  execEnv: NodeJS.ProcessEnv,
): Promise<boolean> {
  log.debug(`Checking tool '${cmd}' with args [${args.join(', ')}]`);

  let result = await tryExeca(cmd, args, '', execEnv);
  if (!result) return false;
  log.debug(
    `Initial check for '${cmd}': exitCode=${result.exitCode}, ` +
      `stdout=${result.stdout?.slice(0, 100) || '(empty)'}, ` +
      `stderr=${result.stderr?.slice(0, 100) || '(empty)'}`,
  );

  // Accept if exit code is 0, OR if we got version-like output
  // (some tools return non-zero for --version but still output version info)
  if (result.exitCode === 0 || hasVersionOutput(result)) {
    log.debug(`Tool '${cmd}' detected successfully`);
    return true;
  }

  const fallback = BinaryResolver.resolveOptionalCommand(cmd, args);
  log.debug(
    `Fallback search for '${cmd}': ${fallback?.resolvedPath ?? 'not found'}`,
  );

  if (fallback) {
    log.debug(
      `Running fallback '${fallback.command}' with args [${fallback.args.join(', ')}]`,
    );
    result = await tryExeca(
      fallback.command,
      fallback.args,
      'fallback ',
      execEnv,
    );
    if (!result) return false;
    log.debug(
      `Fallback result: exitCode=${result.exitCode}, ` +
        `stdout=${result.stdout?.slice(0, 100) || '(empty)'}, ` +
        `stderr=${result.stderr?.slice(0, 100) || '(empty)'}`,
    );

    if (result.exitCode === 0 || hasVersionOutput(result)) {
      return true;
    }
  }

  // Log at info level so it shows in output channel by default
  log.info(
    `Tool '${cmd}' not detected. Last result: exitCode=${result.exitCode}, ` +
      `stdout=${result.stdout?.slice(0, 200) || '(empty)'}, ` +
      `stderr=${result.stderr?.slice(0, 200) || '(empty)'}`,
  );
  return false;
}

/**
 * Generic function to check if a tool is installed
 * @param toolName Tool name (looked up in TOOL_CONFIGS)
 * @param showError Whether to show an error message if the tool is not installed
 * @returns Promise<boolean> True if the tool is installed
 */
export async function checkToolInstalled(
  toolName: string,
  showError: boolean = true,
): Promise<boolean> {
  const config = TOOL_CONFIGS[toolName];

  if (!config) {
    if (showError) {
      await reportMissingTool(`Unknown tool: ${toolName}`);
    }
    return false;
  }

  // Generate default command if not specified
  const command = config.command || `${toolName} --version`;

  try {
    let isInstalled = false;

    const extendedPath = extendEnvPath();
    const execEnv = { ...process.env, PATH: extendedPath };

    // Log PATH info once (not per-command)
    log.debug(
      `PATH contains ${extendedPath.split(path.delimiter).length} entries, ` +
        `includes /usr/bin: ${extendedPath.includes('/usr/bin')}`,
    );

    if (Array.isArray(command)) {
      // Try each command in the array until one succeeds
      for (const cmd of command) {
        const parsed = parseCommand(cmd);
        if (!parsed) continue;
        if (await executeWithFallback(parsed.cmdName, parsed.args, execEnv)) {
          isInstalled = true;
          break;
        }
      }
    } else {
      // Single command: validate first, then execute
      const parsed = parseCommand(command);
      if (!parsed) {
        throw new Error('Invalid command: no executable found');
      }
      isInstalled = await executeWithFallback(
        parsed.cmdName,
        parsed.args,
        execEnv,
      );
    }

    if (!isInstalled && showError) {
      await reportMissingTool(config.errorMessage, config.openDocsCommand);
    }

    return isInstalled;
  } catch (err) {
    // The user-facing message is always the tool's own install guidance, so
    // log the underlying cause instead of dropping it.
    log.warn(`Tool check for '${toolName}' failed: ${toErrorMessage(err)}`);
    if (showError) {
      await reportMissingTool(config.errorMessage);
    }
    return false;
  }
}

/**
 * Options for runToolWithCheck function (internal to this module)
 */
type RunToolOptions = {
  /** Whether to show error messages for missing tools */
  showError?: boolean;
} & ExecuteCommandBaseOptions;

/**
 * Run a tool after verifying it is installed.
 * @param toolName Name of the tool to execute
 * @param args Arguments to pass to the tool (without the tool name)
 * @param options Execution options and installation check settings
 * @returns Promise<ExecResult | false> if the tool ran, or false if the tool is missing
 */
export async function runToolWithCheck(
  toolName: string,
  args: string[],
  options: RunToolOptions = {},
): Promise<ExecResult | false> {
  const { showError = true, ...execOptions } = options;
  if (!(await checkToolInstalled(toolName, showError))) {
    return false;
  }
  return executeCommand([toolName, ...args], execOptions);
}

/**
 * Check if multiple tools are installed
 * @param configs Array of tool names
 * @param showError Whether to show error messages for missing tools
 * @returns Promise<boolean[]> Array of booleans indicating which tools are installed
 */
async function checkMultipleToolsInstalled(
  configs: string[],
  showError: boolean = true,
): Promise<boolean[]> {
  return Promise.all(
    configs.map((config) => checkToolInstalled(config, showError)),
  );
}

/**
 * Which of the two interchangeable image processors is installed, preferring
 * ImageMagick, or `null` when neither is. The single owner of the
 * "magick or gm" alternation that PDF rasterization, image resizing, and the
 * core-dependency check all decide on.
 */
export async function detectImageTool(): Promise<'magick' | 'gm' | null> {
  const [hasMagick, hasGm] = await checkMultipleToolsInstalled(
    ['magick', 'gm'],
    false,
  );
  if (hasMagick) return 'magick';
  if (hasGm) return 'gm';
  return null;
}

/**
 * Get the documentation command for a given tool.
 * @param tool Tool identifier
 * @returns Command string or undefined if not available
 */
export function getToolDocsCommand(tool: string): string | undefined {
  return TOOL_CONFIGS[tool]?.openDocsCommand;
}

/**
 * Check core dependencies required by TeXRA features
 * (latexindent, Perl, Ghostscript, GraphicsMagick/ImageMagick).
 * @param showError Whether to show error messages for missing tools
 * @returns Promise<string[]> Array of missing tool names
 */
export async function checkCoreDependencies(
  showError: boolean = true,
): Promise<string[]> {
  try {
    // Check basic tools
    const basicTools = ['latexindent', 'perl', 'gs'];
    const basicResults = await checkMultipleToolsInstalled(
      basicTools,
      showError,
    );
    const missingBasicTools = basicTools.filter((_, i) => !basicResults[i]);

    // Check for either GraphicsMagick or ImageMagick, and add the image tool
    // to the missing list only if neither is installed.
    if (!(await detectImageTool())) {
      missingBasicTools.push('gm/magick');
      if (showError) {
        const errorMsg =
          'Neither GraphicsMagick nor ImageMagick is installed. Please install either tool for image processing.\n' +
          'GraphicsMagick:\n' +
          GM_INSTRUCTIONS +
          '\n\nOR\n\nImageMagick:\n' +
          MAGICK_INSTRUCTIONS;
        throw new Error(errorMsg);
      }
    }

    return missingBasicTools;
  } catch (error) {
    // If checking fails, assume all tools are missing to prompt user to check
    // This is safer than silently ignoring the error
    log.error(`Failed to check core dependencies: ${toErrorMessage(error)}`);
    return ['latexindent', 'perl', 'gs', 'gm/magick'];
  }
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

  log.debug('No package manager detected');
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
 * once and cached, including misses.
 */
export function hasPackageManager(name: SystemPackageManager): boolean {
  const cached = packageManagerAvailability.get(name);
  if (cached !== undefined) return cached;

  const available = executeCommandSync([name, '--version']).success;
  packageManagerAvailability.set(name, available);
  log.debug(
    available
      ? `Package manager detected: ${name}`
      : `Package manager not found: ${name}`,
  );
  return available;
}
