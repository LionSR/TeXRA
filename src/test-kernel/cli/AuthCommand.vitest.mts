import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCliAuthProfile: vi.fn(),
  initCliPlatform: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/supabaseAuth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/supabaseAuth')>();
  return {
    ...actual,
    getCliAuthProfile: mocks.getCliAuthProfile,
  };
});

const { runCli } = await import('@cli/commands/root');

describe('CLI auth command', () => {
  let stdout = '';
  let stderr = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    mocks.getCliAuthProfile.mockReset().mockResolvedValue({
      authenticated: false,
    });
    mocks.initCliPlatform.mockReset().mockResolvedValue(undefined);
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

  it('defaults bare auth to status while accepting global flags', async () => {
    const result = await runCli(['auth', '--no-color']);

    expect(result.exitCode).toBe(0);
    expect(stdout.trim()).toBe('Not signed in.');
    expect(stderr).toBe('');
    expect(mocks.initCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ quietLogs: true }),
    );
  });

  it('honors structured output on bare auth status', async () => {
    mocks.getCliAuthProfile.mockResolvedValueOnce({
      authenticated: true,
      accountLabel: 'user@example.edu',
      tier: 'Max',
    });

    const result = await runCli([
      'auth',
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      authenticated: true,
      accountLabel: 'user@example.edu',
      tier: 'Max',
    });
    expect(stderr).toBe('');
  });

  it('forwards group-level global flags to explicit auth subcommands', async () => {
    mocks.getCliAuthProfile.mockResolvedValueOnce({
      authenticated: true,
      accountLabel: 'user@example.edu',
      tier: 'Max',
    });

    const result = await runCli(['auth', '--output-format', 'json', 'status']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      authenticated: true,
      accountLabel: 'user@example.edu',
      tier: 'Max',
    });
    expect(stderr).toBe('');
  });
});
