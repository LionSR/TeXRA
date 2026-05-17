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
      signal?: AbortSignal;
      onOutput?: (chunk: {
        stream: 'stdout' | 'stderr';
        chunk: string;
      }) => void;
    }): Promise<{
      exitCode: number | undefined;
      output: string;
      timedOut: boolean;
      cancelled?: boolean;
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

  it('streams stdout and stderr chunks before completion', async () => {
    const { createDesktopTerminalRunner } = await loadDesktopTerminalRunner();
    const cwd = await mkdtemp(join(tmpdir(), 'texra-terminal-runner-'));
    const runner = createDesktopTerminalRunner({ cwd });
    const chunks: Array<{ stream: 'stdout' | 'stderr'; chunk: string }> = [];

    const result = await runner.runCommand({
      name: 'TeXRA Setup Stream Test',
      command: nodeCommand(
        "process.stdout.write('out'); process.stderr.write('err')",
      ),
      timeoutMs: 5_000,
      onOutput: (chunk) => chunks.push(chunk),
    });

    expect(result.exitCode).toBe(0);
    expect(chunks).toEqual(
      expect.arrayContaining([
        { stream: 'stdout', chunk: 'out' },
        { stream: 'stderr', chunk: 'err' },
      ]),
    );
  });

  it('cancels a running command with the supplied abort signal', async () => {
    const { createDesktopTerminalRunner } = await loadDesktopTerminalRunner();
    const cwd = await mkdtemp(join(tmpdir(), 'texra-terminal-runner-'));
    const runner = createDesktopTerminalRunner({ cwd });
    const controller = new AbortController();

    const run = runner.runCommand({
      name: 'TeXRA Setup Cancel Test',
      command: nodeCommand('setTimeout(() => {}, 60_000)'),
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();

    const result = await run;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
  });
});
