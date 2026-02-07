// Third-party imports
import { execa, type Options, ExecaError } from 'execa';
import { quote as shellQuote } from 'shell-quote';

/**
 * Encoding options compatible with execa v9.
 * execa uses a stricter encoding type than Node's BufferEncoding.
 */
type ExecaEncodingOption =
  | 'utf8'
  | 'utf16le'
  | 'buffer'
  | 'hex'
  | 'base64'
  | 'base64url'
  | 'latin1'
  | 'ascii';

// Local imports - log
import type { ExecResult } from '@agent/types/ResultTypes';

// Local imports - common
import { toErrorMessage } from '@common/errors';

// Internal imports
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
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
    return `...${text.slice(-maxChars)}`;
  }
  return text;
}

function normalizeOutput(text: string | null | undefined): string | null {
  return text?.trim() || null;
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
    cwd?: string;
    stdin?: string;
    /** Called with stdout chunks as they arrive, enabling live output streaming. */
    onStdout?: (chunk: string) => void;
    /** Called with stderr chunks as they arrive, enabling live error streaming. */
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<ExecResult> {
  try {
    const workspacePath = options.cwd ?? WorkspaceFS.getPath();
    if (!workspacePath) {
      throw new Error('No workspace path found');
    }

    const env = options.env
      ? { ...process.env, ...options.env }
      : { ...process.env };
    env.PATH = extendEnvPath(env.PATH);

    // Normalize 'utf-8' to 'utf8' for execa compatibility
    const encodingOption: ExecaEncodingOption =
      options.encoding && options.encoding.toLowerCase() === 'utf-8'
        ? 'utf8'
        : ((options.encoding ?? 'utf8') as ExecaEncodingOption);

    const execaOptions: Options = {
      cwd: workspacePath,
      env,
      encoding: encodingOption,
      timeout: options.timeout,
      reject: false,
      input: options.stdin,
    };

    const logChannel = options.channel ?? CHANNEL;

    let subprocess;
    if (Array.isArray(command)) {
      const [cmd, ...args] = command;
      logger.debug(
        logChannel,
        `Running command: ${shellQuote([cmd, ...args])}`,
      );
      subprocess = execa(cmd, args, execaOptions);
    } else {
      logger.debug(logChannel, `Running command: ${command}`);
      subprocess = execa(command, { ...execaOptions, shell: true });
    }

    // Subscribe to stdout/stderr streams for live output if callbacks provided
    if (options.onStdout && subprocess.stdout) {
      subprocess.stdout.on('data', (chunk: Buffer | string) => {
        options.onStdout!(String(chunk));
      });
    }
    if (options.onStderr && subprocess.stderr) {
      subprocess.stderr.on('data', (chunk: Buffer | string) => {
        options.onStderr!(String(chunk));
      });
    }

    const result = await subprocess;

    const stdout = (result.stdout as string) ?? '';
    const stderr = (result.stderr as string) ?? '';
    const exitCode = result.exitCode ?? 1;
    const timedOut = result.timedOut ?? false;

    const shouldTruncate = options.truncate ?? false;
    const formatForLog = (output: string | null) =>
      shouldTruncate && output ? truncateOutput(output) : output;

    const normalizedStdout = normalizeOutput(stdout);
    const normalizedStderr = normalizeOutput(stderr);

    if (normalizedStderr) {
      logger.debug(
        logChannel,
        `Command stderr: ${formatForLog(normalizedStderr)}`,
      );
    }

    return {
      success: exitCode === 0 && !timedOut,
      stdout: normalizedStdout,
      stderr: normalizedStderr,
      timedOut,
      exitCode,
    };
  } catch (err) {
    logger.error(
      options.channel ?? CHANNEL,
      `Error executing command: ${toErrorMessage(err)}`,
    );

    // Handle stderr from ExecaError
    let stderr = null;
    if (err instanceof ExecaError) {
      stderr = err.stderr ? `${err.stderr}`.trim() : null;
    }

    // With reject: false, this catch block only handles actual execution errors
    // (e.g., command not found), not timeouts or non-zero exit codes
    const fallbackOutput = stderr || toErrorMessage(err);
    const normalizedError = normalizeOutput(fallbackOutput);
    return {
      success: false,
      stdout: null,
      stderr: normalizedError,
      timedOut: false, // Real timeouts are handled in the main flow via result.timedOut
      exitCode: 127, // Convention for command not found / execution failure
    };
  }
}
