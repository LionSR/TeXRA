// Third-party imports
import { execa, type Subprocess } from 'execa';
import { nanoid } from 'nanoid';

// Local imports - log
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { extendEnvPath } from './platformPaths';
import type { ExecResult } from '@agent/types/ResultTypes';

const CHANNEL = 'bashSession';
logger.initialize(CHANNEL);

function truncateOutput(output: string, maxLines = 100): string {
  const lines = output.split('\n');
  if (lines.length > maxLines) {
    return (
      lines.slice(0, maxLines).join('\n') +
      `\n\n... Output truncated (${lines.length} total lines) ...`
    );
  }
  return output;
}

function validateCommand(command: string): [boolean, string?] {
  const dangerousPatterns = ['rm -rf /', ':(){:|:&};:'];
  for (const pattern of dangerousPatterns) {
    if (command.includes(pattern)) {
      return [false, pattern];
    }
  }
  return [true];
}

export class BashSession {
  private process: Subprocess | null = null;

  constructor() {
    this.start();
  }

  private start() {
    const cwd = WorkspaceFS.getPath();
    if (!cwd) {
      throw new Error('No workspace path found');
    }
    const env = { ...process.env };
    env.PATH = extendEnvPath(env.PATH);
    this.process = execa('/bin/bash', [], {
      cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      reject: false,
    });
    if (this.process.stdout) {
      this.process.stdout.setEncoding('utf8');
    }
    if (this.process.stderr) {
      this.process.stderr.setEncoding('utf8');
    }
  }

  public restart() {
    if (this.process) {
      this.process.kill();
    }
    this.start();
  }

  public async execute(
    command: string,
    options: { timeout?: number; truncate?: boolean } = {},
  ): Promise<ExecResult> {
    const [valid, reason] = validateCommand(command);
    if (!valid) {
      return {
        success: false,
        stdout: null,
        stderr: `Command contains dangerous pattern: ${reason}`,
        timedOut: false,
      };
    }
    const session = this.process;
    if (!session || !session.stdin || !session.stdout) {
      return {
        success: false,
        stdout: null,
        stderr: 'Bash session not initialized',
        timedOut: false,
      };
    }

    const marker = `__texra_end_${nanoid(6)}__`;
    let stdout = '';
    let stderr = '';

    return new Promise<ExecResult>((resolve) => {
      const timeoutMs = options.timeout ?? 30000;
      const timeoutHandle = setTimeout(() => {
        cleanup(true);
      }, timeoutMs);

      const onStdout = (data: Buffer) => {
        stdout += data.toString();
        if (stdout.includes(marker)) {
          cleanup(false);
        }
      };
      const onStderr = (data: Buffer) => {
        stderr += data.toString();
      };
      const cleanup = (timedOut: boolean) => {
        session.stdout?.off('data', onStdout);
        session.stderr?.off('data', onStderr);
        clearTimeout(timeoutHandle);
        const trimmedOut = stdout.replace(marker, '').trim();
        const resultOut = options.truncate
          ? truncateOutput(trimmedOut)
          : trimmedOut;
        const trimmedErr = stderr.trim() || null;
        resolve({
          success: !timedOut,
          stdout: resultOut || null,
          stderr: trimmedErr,
          timedOut,
        });
      };



      session.stdout?.on('data', onStdout);
      session.stderr?.on('data', onStderr);

      session.stdin?.write(`${command}\necho ${marker}\n`);
    });
  }
}
