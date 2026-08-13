import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  readCliToolGuide: vi.fn(),
  setCliToolEnabled: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mocks.spawn,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cli/runtime/tools')>();
  return {
    ...actual,
    readCliToolGuide: mocks.readCliToolGuide,
    setCliToolEnabled: mocks.setCliToolEnabled,
  };
});

const { runCli } = await import('@cli/commands/root');

/** Run `texra tools <args>` with the shared headless flag tail every
 *  structured-output invocation in this suite carries. */
function runToolsCli(args: readonly string[]): ReturnType<typeof runCli> {
  return runCli([
    'tools',
    ...args,
    '--print',
    '--api-mode',
    'personal',
    '--no-color',
  ]);
}

describe('CLI tools command', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    mocks.initCliPlatform.mockReset().mockResolvedValue(undefined);
    mocks.readCliToolGuide.mockReset().mockReturnValue({
      text: 'Install help',
      command: 'echo install',
    });
    mocks.setCliToolEnabled.mockReset().mockResolvedValue(true);
    mocks.spawn.mockReset();
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('emits JSON for tool toggles', async () => {
    const result = await runToolsCli([
      'disable',
      'codex',
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(mocks.setCliToolEnabled).toHaveBeenCalledWith('codex', false);
    expect(JSON.parse(stdout)).toEqual({
      id: 'codex',
      enabled: false,
      action: 'disabled',
    });
  });

  it('emits NDJSON for tool toggles', async () => {
    const result = await runToolsCli([
      'enable',
      'codex',
      '--output-format',
      'ndjson',
    ]);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    const lines = stdout.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      kind: 'tool-toggle',
      tool: { id: 'codex', enabled: true, action: 'enabled' },
      ts: expect.any(String),
    });
  });

  it('emits JSON for install guides without running the command', async () => {
    const result = await runToolsCli([
      'install',
      'codex',
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toEqual({
      id: 'codex',
      operation: 'install',
      text: 'Install help',
      command: 'echo install',
    });
  });

  it('rejects structured install output when --run would contaminate stdout', async () => {
    const result = await runToolsCli([
      'install',
      'codex',
      '--run',
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('Cannot combine --output-format json|ndjson');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('reports missing install commands before structured --run conflicts', async () => {
    mocks.readCliToolGuide.mockReturnValueOnce({
      text: 'Install help',
    });

    const result = await runToolsCli([
      'install',
      'github-pr-subscription',
      '--run',
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'No install command is registered for github-pr-subscription.',
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects POSIX guide commands with shell operators instead of dropping them', async () => {
    mocks.readCliToolGuide.mockReturnValueOnce({
      text: 'Install help',
      command: 'echo install && echo second-step',
    });

    const result = await runToolsCli(['install', 'codex', '--run']);

    expect(result.exitCode).toBe(1);
    expect(stdout).toBe('Install help\n');
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('emits structured auth guides without launching the external login', async () => {
    mocks.readCliToolGuide.mockReturnValueOnce({
      text: 'Auth help',
      command: 'codex login',
    });

    const result = await runToolsCli([
      'auth',
      'codex',
      '--output-format',
      'ndjson',
    ]);

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe('');
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toMatchObject({
      kind: 'tool-guide',
      guide: {
        id: 'codex',
        operation: 'auth',
        text: 'Auth help',
        command: 'codex login',
      },
      ts: expect.any(String),
    });
  });
});
