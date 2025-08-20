// Third-party imports
// Standard library imports
import * as vscode from 'vscode';

// Local imports - tools

// Local imports
import { executeCommand, checkToolInstalled } from '@utils/system';

// Wolfram configuration is now in toolUtils.ts

// Interface for execution result
export interface WolframScriptResult {
  success: boolean;
  output: string | null;
  error: string | null;
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
  const isInstalled = await checkToolInstalled(
    'wolframscript',
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
    const command = ['wolframscript', '-code', code];

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
  const isInstalled = await checkToolInstalled(
    'wolframscript',
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
    const command = ['wolframscript', '-file', filePath];

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

// The verifyMathematicalExpression helper has been removed. It previously
// wrapped executeWolframCode without adding any logic. Call executeWolframCode
// directly when verification is needed.

export default {
  executeWolframCode,
  executeWolframScriptFile,
};
