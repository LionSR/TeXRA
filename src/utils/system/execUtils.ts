// Third-party imports
import { execaCommand } from 'execa';
import { quote as shellQuote } from 'shell-quote';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import { ExecResult } from '@agent/types/ResultTypes';
import { extendEnvPath } from '@utils/system/platformPaths';

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
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const finalCommand = Array.isArray(command) ? shellQuote(command) : command;
    logger.debug(
      options.channel ?? CHANNEL,
      `Running command: ${finalCommand}`,
    );

    const env = options.env
      ? { ...process.env, ...options.env }
      : { ...process.env };
    env.PATH = extendEnvPath(env.PATH);

    const encodingOption =
      options.encoding && options.encoding.toLowerCase() === 'utf-8'
        ? 'utf8'
        : options.encoding;

    const { stdout, stderr, exitCode, timedOut } = await execaCommand(
      finalCommand,
      {
        cwd: workspacePath,
        env,
        shell: true,
        encoding: (encodingOption ?? 'utf8') as any,
        timeout: options.timeout,
        reject: false,
      },
    );

    const stdoutStr =
      typeof stdout === 'string'
        ? stdout
        : Buffer.from(stdout).toString(encodingOption ?? 'utf8');
    const stderrStr =
      typeof stderr === 'string'
        ? stderr
        : Buffer.from(stderr).toString(encodingOption ?? 'utf8');

    const shouldTruncate = options.truncate ?? false;
    const processOutput = (output: string | null) =>
      shouldTruncate
        ? truncateOutput(output?.trim() || null)
        : output?.trim() || null;

    if (stderrStr && stderrStr.trim()) {
      logger.debug(
        options.channel ?? CHANNEL,
        `Command stderr: ${processOutput(stderrStr)}`,
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
      stdout: processOutput(stdoutStr),
      stderr: processOutput(stderrStr),
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
