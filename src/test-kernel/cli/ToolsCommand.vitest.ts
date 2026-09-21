import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLog, setDebugModeConfig } from '@logger/logUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { FakeStateStore } from '@test/support/FakePlatform';

const mocks = vi.hoisted(() => ({
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
  readCliToolGuide: vi.fn(),
  setCliToolEnabled: vi.fn(),
  execa: vi.fn(),
}));

vi.mock('execa', async (importOriginal) => ({
  ...(await importOriginal<typeof import('execa')>()),
  execa: mocks.execa,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', () => ({
  installCliProcessRuntime: mocks.installCliProcessRuntime,
  disposeCliProcessRuntime: Effect.void,
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
  return runCli(['tools', ...args, '--print', '--no-color']);
}

describe('CLI tools command', () => {
  let stdout = '';
  let stderr = '';
  /** The state store the mocked init hands the command to toggle through. */
  let globalState: FakeStateStore;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stderr = '';
    globalState = new FakeStateStore();
    mocks.initCliPlatform
      .mockReset()
      .mockReturnValue(Effect.succeed({ globalState, runtime: testRuntime() }));
    mocks.installCliProcessRuntime
      .mockReset()
      .mockImplementation(async () => testRuntime());
    mocks.readCliToolGuide.mockReset().mockReturnValue({
      text: 'Install help',
      command: 'echo install',
    });
    mocks.setCliToolEnabled.mockReset().mockReturnValue(Effect.succeed(true));
    mocks.execa.mockReset();
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (chunk) => {
      stderr += chunk;
    });
  });

  afterEach(() => {
    setDebugModeConfig(null);
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
    // The toggle is a program over the store the init handed back; the run arm
    // settles it on the runtime it holds.
    expect(mocks.setCliToolEnabled).toHaveBeenCalledWith(
      globalState,
      'codex',
      false,
    );
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

  it('keeps the runtime build diagnostic off NDJSON stdout', async () => {
    // #12931: the process runtime's layers log while they build — before the
    // platform init that used to be the first thing to install a sink — and
    // the console fallback covering that window sent DEBUG to stdout, so the
    // first line of an NDJSON run was not a record and the stream would not
    // parse. Debug mode is on because it decides how much such a line
    // carries, never whether it is written.
    setDebugModeConfig({ get: () => true });
    mocks.installCliProcessRuntime.mockImplementation(async () => {
      createLog('UsageLogService').debug('UsageLogService started');
      return testRuntime();
    });

    await runToolsCli(['enable', 'codex', '--output-format', 'ndjson']);

    expect(
      stdout
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line).kind),
    ).toEqual(['tool-toggle']);
    expect(stderr).toContain('[UsageLogService] UsageLogService started');
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
    expect(mocks.execa).not.toHaveBeenCalled();
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
    expect(mocks.execa).not.toHaveBeenCalled();
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
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('rejects POSIX guide commands with shell operators instead of dropping them', async () => {
    mocks.readCliToolGuide.mockReturnValueOnce({
      text: 'Install help',
      command: 'echo install && echo second-step',
    });

    const result = await runToolsCli(['install', 'codex', '--run']);

    expect(result.exitCode).toBe(1);
    expect(stdout).toBe('Install help\n');
    expect(mocks.execa).not.toHaveBeenCalled();
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
    expect(mocks.execa).not.toHaveBeenCalled();
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
