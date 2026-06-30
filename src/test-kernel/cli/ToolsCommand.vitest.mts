import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        stdout += String(chunk);
        const cb = rest.find((arg) => typeof arg === 'function') as
          | ((err?: Error | null) => void)
          | undefined;
        cb?.(null);
        return true;
      }) as unknown as ReturnType<typeof vi.spyOn>;
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        stderr += String(chunk);
        const cb = rest.find((arg) => typeof arg === 'function') as
          | ((err?: Error | null) => void)
          | undefined;
        cb?.(null);
        return true;
      }) as unknown as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('emits JSON for tool toggles', async () => {
    const result = await runCli([
      'tools',
      'disable',
      'codex',
      '--print',
      '--api-mode',
      'personal',
      '--output-format',
      'json',
      '--no-color',
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
    const result = await runCli([
      'tools',
      'enable',
      'codex',
      '--print',
      '--api-mode',
      'personal',
      '--output-format',
      'ndjson',
      '--no-color',
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
    const result = await runCli([
      'tools',
      'install',
      'codex',
      '--print',
      '--api-mode',
      'personal',
      '--output-format',
      'json',
      '--no-color',
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
    const result = await runCli([
      'tools',
      'install',
      'codex',
      '--run',
      '--print',
      '--api-mode',
      'personal',
      '--output-format',
      'json',
      '--no-color',
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

    const result = await runCli([
      'tools',
      'install',
      'github-pr-subscription',
      '--run',
      '--print',
      '--api-mode',
      'personal',
      '--output-format',
      'json',
      '--no-color',
    ]);

    expect(result.exitCode).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain(
      'No install command is registered for github-pr-subscription.',
    );
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it('emits structured auth guides without launching the external login', async () => {
    mocks.readCliToolGuide.mockReturnValueOnce({
      text: 'Auth help',
      command: 'codex login',
    });

    const result = await runCli([
      'tools',
      'auth',
      'codex',
      '--print',
      '--api-mode',
      'personal',
      '--output-format',
      'ndjson',
      '--no-color',
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
