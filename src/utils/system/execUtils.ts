// Third-party imports
import { execa, type Options, ExecaError } from 'execa';
import { quote as shellQuote } from 'shell-quote';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { WorkspaceFS } from '@utils/files';
import type { ExecResult } from '@agent/types/ResultTypes';
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

    const env = options.env
      ? { ...process.env, ...options.env }
      : { ...process.env };
    env.PATH = extendEnvPath(env.PATH);

    const encodingOption: BufferEncoding =
      options.encoding && options.encoding.toLowerCase() === 'utf-8'
        ? 'utf8'
        : (options.encoding ?? 'utf8');

    const execaOptions: Options = {
      cwd: workspacePath,
      env,
      encoding: encodingOption as any, // execa v9 type compatibility
      timeout: options.timeout,
      reject: false,
    };

    let stdout: string;
    let stderr: string;
    let exitCode: number;
    let timedOut: boolean;

    if (Array.isArray(command)) {
      // Use execa directly with argument array to avoid shell injection
      const [cmd, ...args] = command;
      const commandForLog = shellQuote([cmd, ...args]);
      logger.debug(
        options.channel ?? CHANNEL,
        `Running command: ${commandForLog}`,
      );
      const result = await execa(cmd, args, execaOptions);
      stdout = (result.stdout as string) ?? '';
      stderr = (result.stderr as string) ?? '';
      exitCode = result.exitCode ?? 1;
      timedOut = result.timedOut ?? false;
    } else {
      logger.debug(options.channel ?? CHANNEL, `Running command: ${command}`);
      const result = await execa(command, {
        ...execaOptions,
        shell: true,
      });
      stdout = (result.stdout as string) ?? '';
      stderr = (result.stderr as string) ?? '';
      exitCode = result.exitCode ?? 1;
      timedOut = result.timedOut ?? false;
    }

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

    // Handle stderr from ExecaError
    let stderr = null;
    if (err instanceof ExecaError) {
      stderr = err.stderr ? String(err.stderr).trim() : null;
    }

    // With reject: false, this catch block only handles actual execution errors
    // (e.g., command not found), not timeouts or non-zero exit codes
    const shouldTruncate = options.truncate ?? false;
    return {
      success: false,
      stdout: null,
      stderr: shouldTruncate
        ? truncateOutput(stderr || errorMessage)
        : stderr || errorMessage,
      timedOut: false, // Real timeouts are handled in the main flow via result.timedOut
    };
  }
}
