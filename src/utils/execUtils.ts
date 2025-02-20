// Standard library imports
import * as cp from 'child_process';
import { promisify } from 'util';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from './fileUtils';

const execAsync = promisify(cp.exec);

const CHANNEL = 'Utils';
logger.initialize(CHANNEL);

const MAX_OUTPUT_LENGTH = 150;

/**
 * Truncate text to maxChars by keeping the end portion.
 */
function truncateOutput(
  text: string | null,
  maxChars: number = MAX_OUTPUT_LENGTH,
): string | null {
  if (text && text.length > maxChars) {
    return '...' + text.slice(-maxChars);
  }
  return text;
}

interface ExecResult {
  success: boolean;
  stdout: string | null;
  stderr: string | null;
}

/**
 * Execute external command with output handling and workspace path management.
 */
export async function executeCommand(
  command: string | string[],
  options: {
    outputFile?: string;
    encoding?: BufferEncoding;
    channel?: string;
    truncate?: boolean;
  } = {},
): Promise<ExecResult> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const finalCommand = Array.isArray(command) ? command.join(' ') : command;
    logger.debug(
      options.channel || CHANNEL,
      `Running command: ${finalCommand}`,
    );

    const { stdout, stderr } = await execAsync(finalCommand, {
      cwd: workspacePath,
      encoding: options.encoding || 'utf8',
    });

    const shouldTruncate = options.truncate ?? false;
    const processOutput = (output: string | null) =>
      shouldTruncate
        ? truncateOutput(output?.trim() || null)
        : output?.trim() || null;

    if (stderr && stderr.trim()) {
      logger.debug(
        options.channel || CHANNEL,
        `Command stderr: ${processOutput(stderr)}`,
      );
    }

    // if (stdout && stdout.trim()) {
    //   logger.debug(
    //     options.channel || CHANNEL,
    //     `Command stdout: ${processOutput(stdout)}`,
    //   );
    // }

    return {
      success: true,
      stdout: processOutput(stdout),
      stderr: processOutput(stderr),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      options.channel || CHANNEL,
      `Error executing command: ${errorMessage}`,
    );

    // Handle stderr from exec errors
    let stderr = null;
    if (err instanceof Error && 'stderr' in err) {
      stderr = (err as any).stderr?.trim() || null;
    }

    const shouldTruncate = options.truncate ?? false;
    return {
      success: false,
      stdout: null,
      stderr: shouldTruncate
        ? truncateOutput(stderr || errorMessage)
        : stderr || errorMessage,
    };
  }
}
