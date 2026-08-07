// Local imports - system utilities
import { executeCommand } from '@utils/system/execUtils';
import { checkToolInstalled } from '@utils/system/toolUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

export const WOLFRAM_CODE_TIMEOUT_MS = 30_000; // 30 s

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

function wolframFailure(error: string): WolframScriptResult {
  return {
    success: false,
    output: null,
    error,
    timedOut: false,
    exitCode: null,
  };
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
    return wolframFailure(WOLFRAM_NOT_INSTALLED_ERROR);
  }

  try {
    const result = await executeCommand(['wolframscript', ...commandArgs], {
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
    return wolframFailure(toErrorMessage(err));
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
