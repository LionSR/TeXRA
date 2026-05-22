// Standard library imports
import * as path from 'path';

// Third-party imports
import { execa, execaSync } from 'execa';
import { parse as shellParse } from 'shell-quote';

// Local imports
import type { ExecResult } from '@agent/types/ResultTypes';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
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
} from '@shared/constants/latex';

// Local file imports
import { IS_WINDOWS, extendEnvPath } from './platformPaths';
import { BinaryResolver } from './binaryResolver';
import { executeCommand } from './execUtils';

const CHANNEL = 'toolUtils';
logger.initialize(CHANNEL);

// Interface for tool configuration (internal to this module)
interface ToolConfig {
  command?: string | string[]; // Optional - defaults to "${toolName} --version"
  errorMessage: string;
  openDocsCommand?: string; // Optional command to open documentation
}

/**
 * Pluggable handler for surfacing tool-missing errors to the user.
 * Set by the extension host at activation; defaults to a no-op so this
 * module remains free of platform-specific (vscode) dependencies.
 */
export type ToolMissingHandler = (
  message: string,
  openDocsCommand?: string,
) => void | Promise<void>;

let toolMissingHandler: ToolMissingHandler = () => {
  // No-op by default; the extension host registers a real handler.
};

/** Register a platform-specific handler for displaying tool-missing errors. */
export function setToolMissingHandler(handler: ToolMissingHandler): void {
  toolMissingHandler = handler;
}

async function reportMissingTool(
  message: string,
  openDocsCommand?: string,
): Promise<void> {
  try {
    await toolMissingHandler(message, openDocsCommand);
  } catch (err) {
    logger.error(
      CHANNEL,
      `Failed to report missing tool: ${toErrorMessage(err)}`,
    );
  }
}

// Platform-specific install instructions resolved at module load.
// All guides are defined in @shared/constants/latex (single source of truth).
const p = process.platform;

const LATEXDIFF_INSTRUCTIONS = getInstallGuide(LATEXDIFF_INSTALL_GUIDE, p);
const LATEXINDENT_INSTRUCTIONS = getInstallGuide(LATEXINDENT_INSTALL_GUIDE, p);
const TEXFMT_INSTRUCTIONS = getInstallGuide(TEXFMT_INSTALL_GUIDE, p);
const TEXCOUNT_INSTRUCTIONS = getInstallGuide(TEXCOUNT_INSTALL_GUIDE, p);
const PERL_INSTRUCTIONS = getInstallGuide(PERL_INSTALL_GUIDE, p);
const GHOSTSCRIPT_INSTRUCTIONS = getInstallGuide(GHOSTSCRIPT_INSTALL_GUIDE, p);
const GM_INSTRUCTIONS = getInstallGuide(GRAPHICSMAGICK_INSTALL_GUIDE, p);
const MAGICK_INSTRUCTIONS = getInstallGuide(IMAGEMAGICK_INSTALL_GUIDE, p);
const WOLFRAM_INSTRUCTIONS = getInstallGuide(WOLFRAM_INSTALL_GUIDE, p);
const PANDOC_INSTRUCTIONS = getInstallGuide(PANDOC_INSTALL_GUIDE, p);
const PDFLATEX_INSTRUCTIONS = getInstallGuide(PDFLATEX_INSTALL_GUIDE, p);
const LATEXMK_INSTRUCTIONS = getInstallGuide(LATEXMK_INSTALL_GUIDE, p);

// All tool configurations in one place
const TOOL_CONFIGS: Record<string, ToolConfig> = {
  // ImageMagick tools
  magick: {
    errorMessage:
      'ImageMagick is not installed. Please install ImageMagick to use PDF to PNG conversion.\n' +
      MAGICK_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },

  // GraphicsMagick
  gm: {
    command: 'gm version',
    errorMessage:
      'GraphicsMagick is not installed. Please install GraphicsMagick to use PDF to PNG conversion.\n' +
      GM_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },

  // System dependencies
  perl: {
    command: 'perl --version',
    errorMessage:
      'Perl is not installed. latexindent requires Perl.\n' + PERL_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  gs: {
    command: IS_WINDOWS
      ? ['gswin64c --version', 'gswin32c --version', 'gs --version']
      : 'gs --version',
    errorMessage:
      'Ghostscript is not installed. Please install Ghostscript to use PDF to PNG conversion.\n' +
      GHOSTSCRIPT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },

  // Wolfram tools
  wolframscript: {
    command: 'wolframscript -version',
    errorMessage:
      '"wolframscript" is not installed or not in your PATH.\n' +
      WOLFRAM_INSTRUCTIONS,
  },

  // LaTeX tools
  latexdiff: {
    errorMessage:
      'latexdiff is not installed. Please install it to use this feature.\n' +
      LATEXDIFF_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  'latexdiff-vc': {
    errorMessage:
      'latexdiff-vc is not installed. Please install it to use this feature.\n' +
      LATEXDIFF_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  latexindent: {
    errorMessage:
      'latexindent is not installed. Please install it to use this feature.\n' +
      LATEXINDENT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  'tex-fmt': {
    errorMessage:
      'tex-fmt is not installed. Please install it to use this feature.\n' +
      TEXFMT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  texcount: {
    errorMessage:
      'texcount is not installed. Please install it to use this feature.\n' +
      TEXCOUNT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  latexmk: {
    errorMessage:
      'latexmk is not installed. Please install it to use this feature.\n' +
      LATEXMK_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  pdflatex: {
    errorMessage:
      'pdflatex is not installed. Please install it to use this feature.\n' +
      PDFLATEX_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  xelatex: {
    errorMessage:
      'xelatex is not installed. Please install a TeX distribution to use this feature.\n' +
      PDFLATEX_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  lualatex: {
    errorMessage:
      'lualatex is not installed. Please install a TeX distribution to use this feature.\n' +
      PDFLATEX_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  bibtex: {
    errorMessage:
      'bibtex is not installed. Please install a TeX distribution to use this feature.\n' +
      PDFLATEX_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  biber: {
    errorMessage:
      'biber is not installed. Please install a TeX distribution to use this feature.\n' +
      PDFLATEX_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },

  // Document conversion tools
  pandoc: {
    errorMessage:
      'pandoc is not installed. Please install it to use this feature.\n' +
      PANDOC_INSTRUCTIONS,
  },
};

/**
 * Generic function to check if a tool is installed
 * @param toolOrConfig Tool name (string) or tool configuration object
 * @param showError Whether to show an error message if the tool is not installed
 * @returns Promise<boolean> True if the tool is installed
 */
export async function checkToolInstalled(
  toolOrConfig: string | ToolConfig,
  showError: boolean = true,
): Promise<boolean> {
  // Get the config object - either passed directly or looked up by string key
  const isStringKey = typeof toolOrConfig === 'string';
  const toolName = isStringKey ? toolOrConfig : null;
  const config = isStringKey ? TOOL_CONFIGS[toolOrConfig] : toolOrConfig;

  if (!config) {
    if (showError) {
      await reportMissingTool(`Unknown tool: ${toolOrConfig}`);
    }
    return false;
  }

  // Generate default command if not specified
  const command = config.command || (toolName ? `${toolName} --version` : null);

  try {
    if (!command) {
      throw new Error(
        'No command specified and tool name could not be determined',
      );
    }

    let isInstalled = false;

    const extendedPath = extendEnvPath();
    const execOptions = {
      env: { ...process.env, PATH: extendedPath },
      reject: false,
      timeout: 5000,
    };

    // Log PATH info once (not per-command)
    logger.debug(
      CHANNEL,
      `PATH contains ${extendedPath.split(path.delimiter).length} entries, ` +
        `includes /usr/bin: ${extendedPath.includes('/usr/bin')}`,
    );

    // Check if output contains version-like pattern (e.g., "3.7.1")
    const hasVersionOutput = (result: { stdout?: string; stderr?: string }) =>
      result.stdout?.match(/\d+\.\d+/) || result.stderr?.match(/\d+\.\d+/);

    const executeWithFallback = async (
      cmd: string,
      args: string[],
    ): Promise<boolean> => {
      logger.debug(
        CHANNEL,
        `Checking tool '${cmd}' with args [${args.join(', ')}]`,
      );

      let result;
      try {
        result = await execa(cmd, args, execOptions);
      } catch (execErr) {
        logger.info(
          CHANNEL,
          `Exception executing '${cmd}': ${toErrorMessage(execErr)}`,
        );
        return false;
      }
      logger.debug(
        CHANNEL,
        `Initial check for '${cmd}': exitCode=${result.exitCode}, ` +
          `stdout=${result.stdout?.slice(0, 100) || '(empty)'}, ` +
          `stderr=${result.stderr?.slice(0, 100) || '(empty)'}`,
      );

      // Accept if exit code is 0, OR if we got version-like output
      // (some tools return non-zero for --version but still output version info)
      if (result.exitCode === 0 || hasVersionOutput(result)) {
        logger.debug(CHANNEL, `Tool '${cmd}' detected successfully`);
        return true;
      }

      const fallback = BinaryResolver.resolveOptionalCommand(cmd, args);
      logger.debug(
        CHANNEL,
        `Fallback search for '${cmd}': ${fallback?.resolvedPath ?? 'not found'}`,
      );

      if (fallback) {
        logger.debug(
          CHANNEL,
          `Running fallback '${fallback.command}' with args [${fallback.args.join(', ')}]`,
        );
        try {
          result = await execa(fallback.command, fallback.args, execOptions);
        } catch (fallbackErr) {
          logger.info(
            CHANNEL,
            `Exception executing fallback '${fallback.command}': ${toErrorMessage(fallbackErr)}`,
          );
          return false;
        }
        logger.debug(
          CHANNEL,
          `Fallback result: exitCode=${result.exitCode}, ` +
            `stdout=${result.stdout?.slice(0, 100) || '(empty)'}, ` +
            `stderr=${result.stderr?.slice(0, 100) || '(empty)'}`,
        );

        if (result.exitCode === 0 || hasVersionOutput(result)) {
          return true;
        }
      }

      // Log at info level so it shows in output channel by default
      logger.info(
        CHANNEL,
        `Tool '${cmd}' not detected. Last result: exitCode=${result.exitCode}, ` +
          `stdout=${result.stdout?.slice(0, 200) || '(empty)'}, ` +
          `stderr=${result.stderr?.slice(0, 200) || '(empty)'}`,
      );
      return false;
    };

    const parseCommand = (cmd: string) => {
      const parts = shellParse(cmd).filter(
        (arg): arg is string => typeof arg === 'string',
      );
      if (parts.length === 0) return null;
      const [cmdName, ...args] = parts;
      return { cmdName, args };
    };

    if (Array.isArray(command)) {
      // Try each command in the array until one succeeds
      for (const cmd of command) {
        const parsed = parseCommand(cmd);
        if (!parsed) continue;
        if (await executeWithFallback(parsed.cmdName, parsed.args)) {
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
      isInstalled = await executeWithFallback(parsed.cmdName, parsed.args);
    }

    if (!isInstalled && showError) {
      await reportMissingTool(config.errorMessage, config.openDocsCommand);
    }

    return isInstalled;
  } catch (err) {
    if (showError) {
      const errorMessage =
        config.errorMessage || `Failed to check tool installation: ${err}`;
      await reportMissingTool(errorMessage);
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
} & Parameters<typeof executeCommand>[1];

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
 * @param configs Array of tool configurations
 * @param showError Whether to show error messages for missing tools
 * @returns Promise<boolean[]> Array of booleans indicating which tools are installed
 */
export async function checkMultipleToolsInstalled(
  configs: string[] | ToolConfig[],
  showError: boolean = true,
): Promise<boolean[]> {
  return Promise.all(
    configs.map((config) => checkToolInstalled(config, showError)),
  );
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

    // Check for either GraphicsMagick or ImageMagick
    const [hasMagick, hasGm] = await checkMultipleToolsInstalled(
      ['magick', 'gm'],
      false, // Don't show errors since we're checking alternatives
    );

    // Add image tool to missing list only if neither is installed
    if (!hasMagick && !hasGm) {
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
    logger.error(
      CHANNEL,
      `Failed to check core dependencies: ${toErrorMessage(error)}`,
    );
    return ['latexindent', 'perl', 'gs', 'gm/magick'];
  }
}

/**
 * Detect the first available package manager on the system.
 * Returns 'brew', 'apt', 'scoop', or null if none found.
 */
let cachedPackageManager: 'brew' | 'apt' | 'scoop' | undefined;

export function detectPackageManager(): 'brew' | 'apt' | 'scoop' | null {
  if (cachedPackageManager !== undefined) return cachedPackageManager;

  const extendedPath = extendEnvPath();
  const execOptions = {
    env: { ...process.env, PATH: extendedPath },
    reject: false,
  };

  // Platform-aware order: check the platform's native PM first so that
  // cross-platform installs (e.g. Linuxbrew on Linux) don't shadow the
  // PM that DEPENDENCY_INSTALL_COMMANDS actually uses for that platform.
  type PM = { name: 'brew' | 'apt' | 'scoop'; args: string[] };
  const allManagers: PM[] = [
    { name: 'brew', args: ['--version'] },
    { name: 'apt', args: ['--version'] },
    { name: 'scoop', args: ['--version'] },
  ];
  const preferred: Record<string, string> = {
    darwin: 'brew',
    linux: 'apt',
    win32: 'scoop',
  };
  const first = preferred[process.platform];
  const managers = first
    ? [
        allManagers.find((m) => m.name === first)!,
        ...allManagers.filter((m) => m.name !== first),
      ]
    : allManagers;

  for (const { name, args } of managers) {
    try {
      const result = execaSync(name, args, execOptions);
      if (result.exitCode === 0) {
        logger.debug(CHANNEL, `Package manager detected: ${name}`);
        cachedPackageManager = name;
        return name;
      }
    } catch {
      // Not available, try next
    }
  }

  logger.debug(CHANNEL, 'No package manager detected');
  return null;
}
