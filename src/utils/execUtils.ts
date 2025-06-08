// Standard library imports
import * as fs from 'fs';
import * as path from 'path';

// Third-party imports
import spawn from 'cross-spawn';
import glob from 'glob';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getWorkspacePath } from './workspaceFileUtils';
import { ExecResult } from '../types/ResultTypes';

const CHANNEL = 'execUtils';
logger.initialize(CHANNEL);

const MAX_OUTPUT_LENGTH = 150;

// Additional directories that commonly contain LaTeX tools
function getExtraDirs(): string[] {
  const dirs: string[] = [];
  const platform = process.platform;

  if (platform === 'darwin') {
    dirs.push(
      '/opt/homebrew/bin', // Homebrew on Apple Silicon
      '/usr/local/bin',
      '/Library/TeX/texbin',
      '/usr/texbin',
    );
  } else if (platform === 'win32') {
    dirs.push(
      'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
      'C:\\Program Files\\MiKTeX\\miktex\\bin',
      'C:\\Program Files (x86)\\MiKTeX\\miktex\\bin',
    );
  } else {
    // Linux and others
    dirs.push(
      '/usr/local/bin',
      '/usr/bin',
      '/usr/texbin',
      '/home/linuxbrew/.linuxbrew/bin',
    );
  }

  const texlivePatterns =
    platform === 'win32'
      ? ['C:/texlive/*/bin/*']
      : ['/usr/local/texlive/*/bin/*'];
  for (const pattern of texlivePatterns) {
    try {
      const matches = glob.sync(pattern).sort().reverse();
      dirs.push(...matches);
    } catch {
      // ignore glob errors
    }
  }

  return Array.from(new Set(dirs));
}

// Extend PATH with common directories if they are missing
export function extendEnvPath(
  basePath: string = process.env.PATH || '',
): string {
  const segments = basePath.split(path.delimiter).filter(Boolean);
  for (const dir of getExtraDirs()) {
    if (!segments.includes(dir) && fs.existsSync(dir)) {
      segments.push(dir);
    }
  }
  return segments.join(path.delimiter);
}

// Locate a tool in the common directories
export function findToolInCommonPaths(tool: string): string | null {
  const candidates = [tool];
  if (process.platform === 'win32' && !tool.toLowerCase().endsWith('.exe')) {
    candidates.unshift(`${tool}.exe`);
  }

  for (const dir of getExtraDirs()) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

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

    const env = options.env
      ? { ...process.env, ...options.env }
      : { ...process.env };
    env.PATH = extendEnvPath(env.PATH);

    const spawnOptions = {
      cwd: workspacePath,
      env,
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
