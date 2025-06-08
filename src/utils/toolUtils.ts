// Standard library imports
import spawn from 'cross-spawn';

// Local imports
import { extendEnvPath, findToolInCommonPaths } from './execUtils';

// Third-party imports
import * as vscode from 'vscode';

// No local imports needed

// Interface for tool configuration
export interface ToolConfig {
  command: string | string[];
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

// All tool configurations in one place
const TOOL_CONFIGS: Record<string, ToolConfig> = {
  // ImageMagick tools
  imagemagick: {
    command: 'convert -version',
    errorMessage:
      'ImageMagick is not installed. Please install ImageMagick to use PDF to PNG conversion.\n' +
      'Installation instructions:\n' +
      '- Mac: brew install imagemagick\n' +
      '- Ubuntu: sudo apt-get install imagemagick\n' +
      '- Windows: Download from https://imagemagick.org/script/download.php',
  },

  // GraphicsMagick
  gm: {
    command: 'gm version',
    errorMessage:
      'GraphicsMagick is not installed. Please install GraphicsMagick to use PDF to PNG conversion.\n' +
      'Installation instructions:\n' +
      '- Mac: brew install graphicsmagick\n' +
      '- Ubuntu: sudo apt-get install graphicsmagick\n' +
      '- Windows: Download from http://www.graphicsmagick.org/download.html',
  },

  // Wolfram tools
  wolframscript: {
    command: 'wolframscript -version',
    errorMessage:
      'Mathematica/wolframscript is not installed or not in your PATH.',
  },

  // LaTeX tools
  latexdiff: {
    command: 'latexdiff --version',
    errorMessage:
      'latexdiff is not installed. Please install it to use this feature.\n' +
      LATEXDIFF_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  'latexdiff-vc': {
    command: 'latexdiff-vc --version',
    errorMessage:
      'latexdiff-vc is not installed. Please install it to use this feature.\n' +
      LATEXDIFF_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  latexindent: {
    command: 'latexindent --version',
    errorMessage:
      'latexindent is not installed. Please install it to use this feature.\n' +
      LATEXINDENT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  'tex-fmt': {
    command: 'tex-fmt --version',
    errorMessage:
      'tex-fmt is not installed. Please install it to use this feature.\n' +
      TEXFMT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
  },
  texcount: {
    command: 'texcount --version',
    errorMessage:
      'texcount is not installed. Please install it to use this feature.\n' +
      TEXCOUNT_INSTRUCTIONS,
    openDocsCommand: 'texra.openDoc,installation',
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
    const config =
      typeof toolOrConfig === 'string'
        ? TOOL_CONFIGS[toolOrConfig]
        : toolOrConfig;

    if (!config) {
      throw new Error(`Unknown tool: ${toolOrConfig}`);
    }

    let isInstalled = false;

    const spawnOptions = {
      env: { ...process.env, PATH: extendEnvPath() },
      shell: true,
    };

    if (Array.isArray(config.command)) {
      // Try each command in the array until one succeeds
      for (const cmd of config.command) {
        let result = spawn.sync(cmd, spawnOptions);
        if (result.status === 0) {
          isInstalled = true;
          break;
        }
        const toolName = cmd.split(' ')[0];
        const fallback = findToolInCommonPaths(toolName);
        if (fallback) {
          const originalArgs = cmd.substring(cmd.indexOf(' ') + 1);
          result = spawn.sync(`${fallback} ${originalArgs}`, spawnOptions);
          if (result.status === 0) {
            isInstalled = true;
            break;
          }
        }
      }
    } else {
      let result = spawn.sync(config.command, spawnOptions);
      isInstalled = result.status === 0;
      if (!isInstalled) {
        const toolName = config.command.split(' ')[0];
        const fallback = findToolInCommonPaths(toolName);
        if (fallback) {
          const originalArgs = config.command.substring(config.command.indexOf(' ') + 1);
          result = spawn.sync(`${fallback} ${originalArgs}`, spawnOptions);
          isInstalled = result.status === 0;
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
