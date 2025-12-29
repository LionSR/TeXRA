// Standard library imports
import * as path from 'path';

// Third-party imports
import { execaSync } from 'execa';
import { parse as shellParse } from 'shell-quote';
import * as vscode from 'vscode';

// Local imports
import type { ExecResult } from '@agent/types/ResultTypes';
import * as logger from '@logger/logUtils';

// Local file imports
import { extendEnvPath, findToolInCommonPaths } from './platformPaths';
import { executeCommand } from './execUtils';

const CHANNEL = 'toolUtils';

// Interface for tool configuration
export interface ToolConfig {
  command?: string | string[]; // Optional - defaults to "${toolName} --version"
  errorMessage: string;
  openDocsCommand?: string; // Optional command to open documentation
}

// Installation instructions for LaTeX tools
const LATEXDIFF_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install latexdiff\n' +
  '- Ubuntu: sudo apt-get install latexdiff\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

const LATEXINDENT_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install latexindent\n' +
  '- Ubuntu: sudo apt-get install texlive-extra-utils\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

const TEXFMT_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Cargo: cargo install tex-fmt\n' +
  '- Mac: brew install tex-fmt\n' +
  '- Debian: apt install tex-fmt';

const TEXCOUNT_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install texcount\n' +
  '- Ubuntu: sudo apt-get install texlive-extra-utils\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

const PERL_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install perl\n' +
  '- Ubuntu: sudo apt-get install perl\n' +
  '- Windows: Download from https://strawberryperl.com/';

const GHOSTSCRIPT_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install ghostscript\n' +
  '- Ubuntu: sudo apt-get install ghostscript\n' +
  '- Windows: Download from https://ghostscript.com/releases/gsdnld.html';

const GM_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install graphicsmagick\n' +
  '- Ubuntu: sudo apt-get install graphicsmagick\n' +
  '- Windows: Download from http://www.graphicsmagick.org/download.html';

const MAGICK_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install imagemagick\n' +
  '- Ubuntu: sudo apt-get install imagemagick\n' +
  '- Windows: Download from https://imagemagick.org/script/download.php';

const WOLFRAM_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install wolfram-engine\n' +
  '- Ubuntu: sudo apt-get install wolfram-engine\n' +
  '- Windows: Download from https://www.wolfram.com/engine/';

const PANDOC_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install pandoc\n' +
  '- Ubuntu: sudo apt-get install pandoc\n' +
  '- Windows: Download from https://pandoc.org/installing.html';

const PDFLATEX_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install texlive\n' +
  '- Ubuntu: sudo apt-get install texlive-full\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

const LATEXMK_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install latexmk\n' +
  '- Ubuntu: sudo apt-get install latexmk\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

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
    command:
      process.platform === 'win32'
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
      'Mathematica/wolframscript is not installed or not in your PATH.\n' +
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
  try {
    // Get the config object - either passed directly or looked up by string key
    const toolName = typeof toolOrConfig === 'string' ? toolOrConfig : null;
    const config =
      typeof toolOrConfig === 'string'
        ? TOOL_CONFIGS[toolOrConfig]
        : toolOrConfig;

    if (!config) {
      throw new Error(`Unknown tool: ${toolOrConfig}`);
    }

    // Generate default command if not specified
    const command =
      config.command || (toolName ? `${toolName} --version` : null);

    if (!command) {
      throw new Error(
        'No command specified and tool name could not be determined',
      );
    }

    let isInstalled = false;

    const execOptions = {
      env: { ...process.env, PATH: extendEnvPath() },
      reject: false,
    };

    // Helper function to execute a command with fallback
    const executeWithFallback = (cmd: string, args: string[]): boolean => {
      let result = execaSync(cmd, args, execOptions);
      if (result.exitCode === 0) {
        return true;
      }

      const fallback = findToolInCommonPaths(cmd);
      if (fallback) {
        const needsPerl =
          fallback.toLowerCase().endsWith('.pl') ||
          (process.platform === 'win32' && path.extname(fallback) === '');
        result = needsPerl
          ? execaSync('perl', [fallback, ...args], execOptions)
          : execaSync(fallback, args, execOptions);
        return result.exitCode === 0;
      }
      return false;
    };

    if (Array.isArray(command)) {
      // Try each command in the array until one succeeds
      for (const cmd of command) {
        const parsedArgs = shellParse(cmd);
        const stringArgs = parsedArgs.filter(
          (arg): arg is string => typeof arg === 'string',
        );
        if (stringArgs.length === 0) continue;
        const [cmdName, ...args] = stringArgs;
        if (executeWithFallback(cmdName, args)) {
          isInstalled = true;
          break;
        }
      }
    } else {
      const parsedArgs = shellParse(command);
      const stringArgs = parsedArgs.filter(
        (arg): arg is string => typeof arg === 'string',
      );
      if (stringArgs.length === 0) {
        throw new Error('Invalid command: no executable found');
      }
      const [cmdName, ...args] = stringArgs;
      isInstalled = executeWithFallback(cmdName, args);
    }

    if (!isInstalled && showError) {
      const actions: string[] = [];
      if (config.openDocsCommand) {
        actions.push('View Installation Guide');
      }

      const choice = await vscode.window.showErrorMessage(
        config.errorMessage,
        ...actions,
      );

      if (choice === 'View Installation Guide' && config.openDocsCommand) {
        // Handle commands with additional arguments separated by comma
        const [command, ...args] = config.openDocsCommand.split(',');
        void vscode.commands.executeCommand(command, ...args);
      }
    }

    return isInstalled;
  } catch (err) {
    if (showError) {
      const config =
        typeof toolOrConfig === 'string'
          ? TOOL_CONFIGS[toolOrConfig]
          : toolOrConfig;
      const errorMessage =
        config?.errorMessage || `Failed to check tool installation: ${err}`;
      vscode.window.showErrorMessage(errorMessage);
    }
    return false;
  }
}

/**
 * Options for runToolWithCheck function
 */
export type RunToolOptions = {
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
  const results = await Promise.all(
    configs.map((config) => checkToolInstalled(config, showError)),
  );
  return results;
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
    const missingTools = [...missingBasicTools];
    if (!hasMagick && !hasGm) {
      missingTools.push('gm/magick');
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

    return missingTools;
  } catch (error) {
    // If checking fails, assume all tools are missing to prompt user to check
    // This is safer than silently ignoring the error
    const message = error instanceof Error ? error.message : String(error);
    logger.error(CHANNEL, `Failed to check core dependencies: ${message}`);
    return ['latexindent', 'perl', 'gs', 'gm/magick'];
  }
}
