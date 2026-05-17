import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopTerminalRunnerModule {
  createDesktopTerminalRunner(options?: { cwd?: string }): {
    runCommand(request: {
      name: string;
      command: string;
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeoutMs: number;
    }): Promise<{
      exitCode: number | undefined;
      output: string;
      timedOut: boolean;
    }>;
  };
}

async function loadDesktopTerminalRunner(): Promise<DesktopTerminalRunnerModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopTerminalRunner.ts'))
  ) as Promise<DesktopTerminalRunnerModule>;
}

function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe('desktop terminal runner', () => {
  it('captures command output and exit status', async () => {
    const { createDesktopTerminalRunner } = await loadDesktopTerminalRunner();
    const cwd = await mkdtemp(join(tmpdir(), 'texra-terminal-runner-'));
    const runner = createDesktopTerminalRunner({ cwd });

    const result = await runner.runCommand({
      name: 'TeXRA Setup Test',
      command: nodeCommand(
        "process.stdout.write('stdout ok'); process.stderr.write('stderr ok')",
      ),
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
    });
    expect(result.output).toContain('stdout ok');
    expect(result.output).toContain('stderr ok');
  });

  it('passes defined environment values and drops undefined values', async () => {
    const { createDesktopTerminalRunner } = await loadDesktopTerminalRunner();
    const cwd = await mkdtemp(join(tmpdir(), 'texra-terminal-runner-'));
    const runner = createDesktopTerminalRunner({ cwd });

    const result = await runner.runCommand({
      name: 'TeXRA Setup Env Test',
      command: nodeCommand(
        [
          "process.stdout.write(process.env.TEXRA_RUNNER_VALUE ?? 'missing')",
          "process.stdout.write(process.env.TEXRA_RUNNER_UNSET === undefined ? ':unset' : ':set')",
        ].join(';'),
      ),
      env: {
        TEXRA_RUNNER_VALUE: 'value',
        TEXRA_RUNNER_UNSET: undefined,
      },
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('value:unset');
  });

  it('keeps only a bounded output tail while streaming', async () => {
    const { createDesktopTerminalRunner } = await loadDesktopTerminalRunner();
    const cwd = await mkdtemp(join(tmpdir(), 'texra-terminal-runner-'));
    const runner = createDesktopTerminalRunner({ cwd });

    const result = await runner.runCommand({
      name: 'TeXRA Setup Long Output Test',
      command: nodeCommand(
        "process.stdout.write('a'.repeat(13000)); process.stdout.write('tail')",
      ),
      timeoutMs: 5_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeLessThanOrEqual(12_000);
    expect(result.output.endsWith('tail')).toBe(true);
  });
});
