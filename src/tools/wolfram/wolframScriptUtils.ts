// Third-party imports
import * as vscode from 'vscode';

// Local imports - system utilities
import { executeCommand, checkToolInstalled } from '@utils/system';

// Wolfram configuration is now in toolUtils.ts

// Constants
const DEFAULT_CODE_TIMEOUT = 30000; // 30 seconds
const DEFAULT_FILE_TIMEOUT = 60000; // 60 seconds
const WOLFRAM_NOT_INSTALLED_ERROR =
  'Mathematica/wolframscript is not installed or not in your PATH.';
const WOLFRAM_CHANNEL = 'WolframTool';

// Interface for execution result
export interface WolframScriptResult {
  success: boolean;
  output: string | null;
  error: string | null;
}

/**
 * Internal helper to run wolframscript commands with installation check.
 * @param commandArgs Array of command-line arguments to pass to wolframscript (e.g., ['-code', 'expr'] or ['-file', 'path'])
 * @param opts Execution options including timeout and error display settings
 * @returns Promise resolving to execution result with success status, output, and error information
 */
async function runWolfram(
  commandArgs: string[],
  opts: { timeout?: number; showErrorsToUser?: boolean } = {},
): Promise<WolframScriptResult> {
  const isInstalled = await checkToolInstalled(
    'wolframscript',
    opts.showErrorsToUser,
  );
  if (!isInstalled) {
    return {
      success: false,
      output: null,
      error: WOLFRAM_NOT_INSTALLED_ERROR,
    };
  }

  try {
    const command = ['wolframscript', ...commandArgs];
    const result = await executeCommand(command, {
      truncate: false,
      timeout: opts.timeout,
      channel: WOLFRAM_CHANNEL,
    });

    return {
      success: result.success,
      output: result.stdout,
      error: result.stderr,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    if (opts.showErrorsToUser) {
      vscode.window.showErrorMessage(
        `Error executing Wolfram command: ${errorMessage}`,
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
  return runWolfram(['-code', code], {
    timeout: options.timeout ?? DEFAULT_CODE_TIMEOUT,
    showErrorsToUser: options.showErrorsToUser,
  });
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
  return runWolfram(['-file', filePath], {
    timeout: options.timeout ?? DEFAULT_FILE_TIMEOUT,
    showErrorsToUser: options.showErrorsToUser,
  });
}

// The verifyMathematicalExpression helper has been removed. It previously
// wrapped executeWolframCode without adding any logic. Call executeWolframCode
// directly when verification is needed.

export default {
  executeWolframCode,
  executeWolframScriptFile,
};
