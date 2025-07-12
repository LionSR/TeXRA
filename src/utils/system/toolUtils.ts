// Standard library imports
import { execaSync } from 'execa';
import { parse as shellParse } from 'shell-quote';

// Local imports
import { extendEnvPath, findToolInCommonPaths } from './platformPaths';

// Third-party imports
import * as vscode from 'vscode';

// No local imports needed

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
  },

  // GraphicsMagick
  gm: {
    command: 'gm version',
    errorMessage:
      'GraphicsMagick is not installed. Please install GraphicsMagick to use PDF to PNG conversion.\n' +
      GM_INSTRUCTIONS,
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

    if (Array.isArray(command)) {
      // Try each command in the array until one succeeds
      for (const cmd of command) {
        const parsedArgs = shellParse(cmd);
        const stringArgs = parsedArgs.filter((arg): arg is string => typeof arg === 'string');
        if (stringArgs.length === 0) continue;
        const [cmdName, ...args] = stringArgs;
        let result = execaSync(cmdName, args, execOptions);
        if (result.exitCode === 0) {
          isInstalled = true;
          break;
        }
        const fallback = findToolInCommonPaths(cmdName);
        if (fallback) {
          result = execaSync(fallback, args, execOptions);
          if (result.exitCode === 0) {
            isInstalled = true;
            break;
          }
        }
      }
    } else {
      const parsedArgs = shellParse(command);
      const stringArgs = parsedArgs.filter((arg): arg is string => typeof arg === 'string');
      if (stringArgs.length === 0) {
        throw new Error('Invalid command: no executable found');
      }
      const [cmdName, ...args] = stringArgs;
      let result = execaSync(cmdName, args, execOptions);
      isInstalled = result.exitCode === 0;
      if (!isInstalled) {
        const fallback = findToolInCommonPaths(cmdName);
        if (fallback) {
          result = execaSync(fallback, args, execOptions);
          isInstalled = result.exitCode === 0;
        }
      }
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
        vscode.commands.executeCommand(command, ...args);
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
