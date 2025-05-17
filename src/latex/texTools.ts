// Standard library imports
import * as path from 'path';
import { promisify } from 'util';
import { exec } from 'child_process';

// Third-party imports
import * as vscode from 'vscode';

const execAsync = promisify(exec);

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { executeCommand } from '../utils/execUtils';
import { getConfig } from '../utils/configUtils';
import { getWorkspacePath } from '../utils/workspaceFileUtils';

const CHANNEL = 'LaTeXCommands';
logger.initialize(CHANNEL);

// Installation instructions for each tool
export const LATEXDIFF_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install latexdiff\n' +
  '- Ubuntu: sudo apt-get install latexdiff\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

export const LATEXINDENT_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install latexindent\n' +
  '- Ubuntu: sudo apt-get install texlive-extra-utils\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

export const TEXCOUNT_INSTRUCTIONS =
  'Installation instructions:\n' +
  '- Mac: brew install texcount\n' +
  '- Ubuntu: sudo apt-get install texlive-extra-utils\n' +
  '- Windows: Install through MiKTeX or TeX Live package manager';

// Tool configurations
interface ToolConfig {
  command: string;
  errorMessage: string;
}

const TOOL_CONFIGS: Record<string, ToolConfig> = {
  latexdiff: {
    command: 'latexdiff --version',
    errorMessage:
      'latexdiff is not installed. Please install it to use this feature.\n' +
      LATEXDIFF_INSTRUCTIONS,
  },
  'latexdiff-vc': {
    command: 'latexdiff-vc --version',
    errorMessage:
      'latexdiff-vc is not installed. Please install it to use this feature.\n' +
      LATEXDIFF_INSTRUCTIONS,
  },
  latexindent: {
    command: 'latexindent --version',
    errorMessage:
      'latexindent is not installed. Please install it to use this feature.\n' +
      LATEXINDENT_INSTRUCTIONS,
  },
  texcount: {
    command: 'texcount --version',
    errorMessage:
      'texcount is not installed. Please install it to use this feature.\n' +
      TEXCOUNT_INSTRUCTIONS,
  },
};

// Export error messages for backward compatibility
export const LATEXDIFF_ERROR = TOOL_CONFIGS.latexdiff.errorMessage;
export const LATEXDIFF_VC_ERROR = TOOL_CONFIGS['latexdiff-vc'].errorMessage;
export const LATEXINDENT_ERROR = TOOL_CONFIGS.latexindent.errorMessage;
export const TEXCOUNT_ERROR = TOOL_CONFIGS.texcount.errorMessage;

/**
 * Generic function to check if a LaTeX tool is installed
 * @param tool The tool to check ('latexdiff', 'latexdiff-vc', 'latexindent', 'texcount')
 * @param showError Whether to show an error message if the tool is not installed
 * @returns Promise<boolean> True if the tool is installed
 */
export async function checkToolInstalled(
  tool: keyof typeof TOOL_CONFIGS,
  showError: boolean = true,
): Promise<boolean> {
  try {
    await execAsync(TOOL_CONFIGS[tool].command);
    return true;
  } catch (err) {
    if (showError) {
      const openDocs = 'View Installation Guide';
      const choice = await vscode.window.showErrorMessage(
        TOOL_CONFIGS[tool].errorMessage,
        openDocs,
      );
      if (choice === openDocs) {
        vscode.commands.executeCommand('texra.openDoc', 'installation');
      }
    }
    return false;
  }
}

// Specific tool check functions for backward compatibility
export async function checkLatexdiffInstalled(): Promise<boolean> {
  return checkToolInstalled('latexdiff', false);
}

export async function checkLatexdiffVcInstalled(): Promise<boolean> {
  return checkToolInstalled('latexdiff-vc', false);
}

export async function checkLatexindentInstalled(): Promise<boolean> {
  return checkToolInstalled('latexindent', false);
}

export async function checkTexcountInstalled(): Promise<boolean> {
  return checkToolInstalled('texcount', false);
}

/**
 * Compile a LaTeX file to PDF
 * @param latexFile Path to the LaTeX file
 * @param channel Optional channel for logging
 * @returns Promise<boolean> True if compilation succeeded
 */
export async function compileLatex2Pdf(
  latexFile: string,
  channel: string = CHANNEL,
): Promise<boolean> {
  try {
    const outputDirectory = path.dirname(latexFile);

    // Get TikZ input directory from configuration
    const tikzInputDirectory = getConfig<string>(
      'latex.tikzInputDirectory',
      '',
    );

    // Check if workspace path should be included
    const includeWorkspace = getConfig<boolean>(
      'latex.includeWorkspaceInTexinputs',
      true,
    );

    // Create environment variables with TEXINPUTS if TikZ input directory is configured
    const env: Record<string, string> = {};

    // Start with the current directory
    let texInputs = '.:';

    // Add the workspace path if configured to do so
    if (includeWorkspace) {
      const workspacePath = getWorkspacePath();
      if (workspacePath) {
        texInputs += `${workspacePath}:`;
        logger.debug(
          channel,
          `Including workspace path in TEXINPUTS: ${workspacePath}`,
        );
      }
    }

    // Add TikZ input directory if configured
    if (tikzInputDirectory && tikzInputDirectory.trim() !== '') {
      texInputs += `${tikzInputDirectory}:`;
      logger.debug(
        channel,
        `Including TikZ input directory in TEXINPUTS: ${tikzInputDirectory}`,
      );
    }

    // Append the existing TEXINPUTS if any
    if (process.env.TEXINPUTS) {
      texInputs += process.env.TEXINPUTS;
    }

    // Only set TEXINPUTS if we have something to set
    if (texInputs !== '.:') {
      env.TEXINPUTS = texInputs;
      logger.debug(channel, `Setting TEXINPUTS to: ${texInputs}`);
    }

    const command = [
      'pdflatex',
      '-interaction=nonstopmode',
      `-output-directory="${outputDirectory}"`,
      `"${latexFile}"`,
    ];

    const result = await executeCommand(command, { channel, env });
    if (result.success) {
      logger.info(channel, `Successfully compiled ${latexFile}`);
      return true;
    }
    return false;
  } catch (err) {
    logger.error(
      channel,
      `Error compiling LaTeX: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
