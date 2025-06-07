// Standard library imports
// Third-party imports
import spawn from 'cross-spawn';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from './workspaceFileUtils';
import { ExecResult } from '../types/ResultTypes';

const CHANNEL = 'execUtils';
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
    env?: Record<string, string>;
    timeout?: number;
  } = {},
): Promise<ExecResult> {
  try {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const finalCommand = Array.isArray(command) ? command.join(' ') : command;
    logger.debug(
      options.channel ?? CHANNEL,
      `Running command: ${finalCommand}`,
    );

    const spawnOptions = {
      cwd: workspacePath,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      shell: true,
    };

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    }>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(finalCommand, [], spawnOptions);

      child.stdout?.on('data', (data) => {
        stdout += data.toString(options.encoding ?? 'utf8');
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString(options.encoding ?? 'utf8');
      });

      let timer: NodeJS.Timeout | undefined;
      if (options.timeout) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, options.timeout);
      }

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code, timedOut });
      });
    });

    const { stdout, stderr, exitCode, timedOut } = result;

    const shouldTruncate = options.truncate ?? false;
    const processOutput = (output: string | null) =>
      shouldTruncate
        ? truncateOutput(output?.trim() || null)
        : output?.trim() || null;

    if (stderr && stderr.trim()) {
      logger.debug(
        options.channel ?? CHANNEL,
        `Command stderr: ${processOutput(stderr)}`,
      );
    }

    // if (stdout && stdout.trim()) {
    //   logger.debug(
    //     options.channel ?? CHANNEL,
    //     `Command stdout: ${processOutput(stdout)}`,
    //   );
    // }

    return {
      success: exitCode === 0 && !timedOut,
      stdout: processOutput(stdout),
      stderr: processOutput(stderr),
      timedOut,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(
      options.channel ?? CHANNEL,
      `Error executing command: ${errorMessage}`,
    );

    // Handle stderr from exec errors
    let stderr = null;
    if (err instanceof Error && 'stderr' in err) {
      stderr = (err as any).stderr?.trim() || null;
    }

    // Check if it's a timeout error
    const isTimeout =
      err instanceof Error &&
      (errorMessage.includes('ETIMEDOUT') || errorMessage.includes('Timeout'));

    const shouldTruncate = options.truncate ?? false;
    return {
      success: false,
      stdout: null,
      stderr: shouldTruncate
        ? truncateOutput(stderr || errorMessage)
        : stderr || errorMessage,
      timedOut: isTimeout,
    };
  }
}
