// Standard library imports
import * as vscode from 'vscode';

// Local imports
import { executeCommand } from '../utils/execUtils';

// Constants for wolframscript configuration
const WOLFRAM_SCRIPT_CONFIG = {
  command: 'wolframscript -version',
  errorMessage:
    'Mathematica/wolframscript is not installed or not in your PATH.',
};

// Interface for execution result
export interface WolframScriptResult {
  success: boolean;
  output: string | null;
  error: string | null;
}

/**
 * Check if wolframscript is installed and available
 * @param showError Whether to show an error message to the user if not installed
 * @returns A promise that resolves to a boolean indicating if the tool is installed
 */
export async function checkWolframScriptInstalled(
  showError: boolean = true,
): Promise<boolean> {
  try {
    const result = await executeCommand(WOLFRAM_SCRIPT_CONFIG.command, {
      truncate: false,
      channel: 'WolframTool',
    });

    if (!result.success) {
      if (showError) {
        vscode.window.showErrorMessage(WOLFRAM_SCRIPT_CONFIG.errorMessage);
      }
      return false;
    }

    return true;
  } catch (err) {
    if (showError) {
      vscode.window.showErrorMessage(WOLFRAM_SCRIPT_CONFIG.errorMessage);
    }
    return false;
  }
}

/**
 * Execute Wolfram Language code through wolframscript
 * @param code The Wolfram Language code to execute
 * @param options Additional options for execution
 * @returns A promise that resolves to the execution result
 */
export async function executeWolframCode(
  code: string,
  options: {
    timeout?: number;
    showErrorsToUser?: boolean;
  } = {},
): Promise<WolframScriptResult> {
  // Check if wolframscript is installed before attempting to run code
  const isInstalled = await checkWolframScriptInstalled(
    options.showErrorsToUser,
  );
  if (!isInstalled) {
    return {
      success: false,
      output: null,
      error: 'Mathematica/wolframscript is not installed or not in your PATH.',
    };
  }

  try {
    // Escape the code appropriately for shell execution
    const escapedCode = code.replace(/'/g, "'\\''");
    const command = `wolframscript -code '${escapedCode}'`;

    const result = await executeCommand(command, {
      truncate: false,
      timeout: options.timeout || 30000, // Default 30 second timeout
      channel: 'WolframTool',
    });

    return {
      success: result.success,
      output: result.stdout,
      error: result.stderr,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (options.showErrorsToUser) {
      vscode.window.showErrorMessage(
        `Error executing Wolfram code: ${errorMessage}`,
      );
    }

    return {
      success: false,
      output: null,
      error: errorMessage,
    };
  }
}

/**
 * Execute a Wolfram Language script file
 * @param filePath Path to the Wolfram Language script file
 * @param options Additional options for execution
 * @returns A promise that resolves to the execution result
 */
export async function executeWolframScriptFile(
  filePath: string,
  options: {
    timeout?: number;
    showErrorsToUser?: boolean;
  } = {},
): Promise<WolframScriptResult> {
  // Check if wolframscript is installed before attempting to run the script
  const isInstalled = await checkWolframScriptInstalled(
    options.showErrorsToUser,
  );
  if (!isInstalled) {
    return {
      success: false,
      output: null,
      error: 'Mathematica/wolframscript is not installed or not in your PATH.',
    };
  }

  try {
    const command = `wolframscript -file "${filePath}"`;

    const result = await executeCommand(command, {
      truncate: false,
      timeout: options.timeout || 60000, // Default 1 minute timeout for script files
      channel: 'WolframTool',
    });

    return {
      success: result.success,
      output: result.stdout,
      error: result.stderr,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (options.showErrorsToUser) {
      vscode.window.showErrorMessage(
        `Error executing Wolfram script file: ${errorMessage}`,
      );
    }

    return {
      success: false,
      output: null,
      error: errorMessage,
    };
  }
}

/**
 * Helper to verify mathematical derivations or expressions
 * @param expression The mathematical expression to verify
 * @returns A promise that resolves to the verification result
 */
export async function verifyMathematicalExpression(
  expression: string,
): Promise<WolframScriptResult> {
  // Simple wrapper that could be expanded with specific verification logic
  return executeWolframCode(expression);
}

export default {
  checkWolframScriptInstalled,
  executeWolframCode,
  executeWolframScriptFile,
  verifyMathematicalExpression,
};
