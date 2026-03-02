// Local imports - system utilities
import { toErrorMessage } from '@common/errors';
import { executeCommand, checkToolInstalled } from '@utils/system';

export const WOLFRAM_CODE_TIMEOUT_MS = 30_000; // 30 s
export const WOLFRAM_FILE_TIMEOUT_MS = 60_000; // 60 s

const WOLFRAM_NOT_INSTALLED_ERROR =
  '"wolframscript" is not installed or not in your PATH. ' +
  'Having Mathematica installed is not enough — install the free ' +
  'Wolfram Engine (https://www.wolfram.com/engine/) which includes WolframScript.';
const WOLFRAM_CHANNEL = 'WolframTool';

// Interface for execution result
export interface WolframScriptResult {
  success: boolean;
  output: string | null;
  error: string | null;
  timedOut: boolean;
  exitCode: number | null;
}

/**
 * Internal helper to run wolframscript commands with installation check.
 * @param commandArgs Array of command-line arguments to pass to wolframscript (e.g., ['-code', 'expr'] or ['-file', 'path'])
 * @param timeout Execution timeout in milliseconds
 * @returns Promise resolving to execution result with success status, output, and error information
 */
async function runWolfram(
  commandArgs: string[],
  timeout?: number,
): Promise<WolframScriptResult> {
  const isInstalled = await checkToolInstalled('wolframscript', false);
  if (!isInstalled) {
    return {
      success: false,
      output: null,
      error: WOLFRAM_NOT_INSTALLED_ERROR,
      timedOut: false,
      exitCode: null,
    };
  }

  try {
    const command = ['wolframscript', ...commandArgs];
    const result = await executeCommand(command, {
      truncate: false,
      timeout,
      channel: WOLFRAM_CHANNEL,
    });

    return {
      success: result.success,
      output: result.stdout,
      error: result.stderr,
      timedOut: result.timedOut ?? false,
      exitCode: result.exitCode ?? null,
    };
  } catch (err) {
    const errorMessage = toErrorMessage(err);

    return {
      success: false,
      output: null,
      error: errorMessage,
      timedOut: false,
      exitCode: null,
    };
  }
}

/**
 * Execute Wolfram Language code through wolframscript.
 * @param code The Wolfram Language code to execute
 * @param options.timeout Execution timeout in milliseconds (default: 30 s)
 */
export async function executeWolframCode(
  code: string,
  options: { timeout?: number } = {},
): Promise<WolframScriptResult> {
  return runWolfram(
    ['-code', code],
    options.timeout ?? WOLFRAM_CODE_TIMEOUT_MS,
  );
}

/**
 * Execute a Wolfram Language script file.
 * @param filePath Path to the Wolfram Language script file
 * @param options.timeout Execution timeout in milliseconds (default: 60 s)
 */
export async function executeWolframScriptFile(
  filePath: string,
  options: { timeout?: number } = {},
): Promise<WolframScriptResult> {
  return runWolfram(
    ['-file', filePath],
    options.timeout ?? WOLFRAM_FILE_TIMEOUT_MS,
  );
}
