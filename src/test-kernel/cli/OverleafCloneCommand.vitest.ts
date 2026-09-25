// Node imports
import { access, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { NO_PLATFORM_INSTALL } from '@cli/runtime/cliProcessRuntime';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { overleafGitClone } from '@latex/overleafProject';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { testRuntime } from '@test/support/testProcessRuntime';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { makeMachineGitEnv } from '@utils/system/gitEnv';
import type * as ChildProcess from 'effect/unstable/process/ChildProcess';

const mocks = vi.hoisted(() => ({
  deleteSecret: vi.fn(),
  getSecret: vi.fn(),
  installCliProcessRuntime: vi.fn(),
  readCliAmbientState: vi.fn(),
  setSecret: vi.fn(),
}));

// `clone` is a platform-less entry: its command entry installs the process
// runtime and runs the clone program on what it gets back. Here that is the
// harness's runtime, and the install itself is a spy, so the suite can assert
// what the entry hands it — `NO_PLATFORM_INSTALL`, the real one, spread in
// from the module below. Dropping that argument is what would open the global
// root's handle and hold the event loop past clone's own exit.
vi.mock('@cli/runtime/cliProcessRuntime', async (importOriginal) => {
  const { testRuntime } = await import('@test/support/testProcessRuntime');
  const { Effect: EffectModule } = await import('effect');
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliProcessRuntime')>();
  mocks.installCliProcessRuntime.mockImplementation(() =>
    Promise.resolve(testRuntime()),
  );
  return {
    ...actual,
    installCliProcessRuntime: mocks.installCliProcessRuntime,
    disposeCliProcessRuntime: EffectModule.void,
  };
});

vi.mock('@cli/runtime/cliSecrets', () => ({
  getCliSecrets: () => ({
    get: mocks.getSecret,
    delete: mocks.deleteSecret,
    set: mocks.setSecret,
  }),
}));

vi.mock('@cli/runtime/cliContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliContext')>()),
  readCliAmbientState: mocks.readCliAmbientState,
}));

const { runCli } = await import('@cli/commands/root');

const PROJECT_ID = '0123456789abcdef01234567';

type Answer = ReturnType<Parameters<typeof scriptedSpawnerLayer>[0]>;

/**
 * The process edge, scripted: `git --version` answers with `gitVersion`, the
 * clone with `clone`. Every program the harness runtime runs gets the
 * scripted spawner innermost, so nothing is spawned.
 */
const spawn: {
  gitVersion: Answer;
  clone: (command: ChildProcess.StandardCommand) => Answer;
  calls: ChildProcess.StandardCommand[];
  killed: ChildProcess.StandardCommand[];
} = { gitVersion: {}, clone: () => ({}), calls: [], killed: [] };

const isClone = (command: ChildProcess.StandardCommand) =>
  command.command === 'git' && command.args.includes('clone');

function cloneCalls(): ChildProcess.StandardCommand[] {
  return spawn.calls.filter(isClone);
}

/**
 * The clone ran against the tokenless remote with the token only in the
 * helper's environment, then offered it to the user's credential helper.
 */
function expectClonedInto(cwd: string): void {
  const clone = overleafGitClone(
    { host: 'git.overleaf.com', path: `/${PROJECT_ID}`, isOverleaf: true },
    'olp_secret',
  );
  const [command] = cloneCalls();
  expect(command?.args).toEqual(clone.args);
  expect(command?.options).toMatchObject({
    cwd,
    env: { ...makeMachineGitEnv(), ...clone.env },
    extendEnv: false,
  });
  const approve = spawn.calls.find((call) => call.args[0] === 'credential');
  expect(approve?.args).toEqual(['credential', 'approve']);
  expect(approve?.options).toMatchObject({ cwd, extendEnv: false });
}

async function withProcessCwd<T>(
  cwd: string,
  run: () => Promise<T>,
): Promise<T> {
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  try {
    return await run();
  } finally {
    cwdSpy.mockRestore();
  }
}

describe('CLI Overleaf clone command', () => {
  const tempDirs = useTempDirs();
  let workspacePath: string;
  let stdout: string;
  let stderr: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let runtimeSpy: ReturnType<typeof vi.spyOn>;
  let hostAbort: AbortController | undefined;

  beforeEach(async () => {
    workspacePath = await makeTempDir('texra-clone-', tempDirs);
    stdout = '';
    stderr = '';
    stdoutSpy = spyOnStreamWrite(process.stdout, (text) => {
      stdout += text;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (text) => {
      stderr += text;
    });
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.installCliProcessRuntime.mockImplementation(() =>
      Promise.resolve(testRuntime()),
    );
    mocks.deleteSecret.mockReturnValue(Effect.void);
    spawn.gitVersion = { stdout: 'git version 2.50.0' };
    spawn.clone = () => ({});
    const scripted = scriptedSpawnerLayer((command) =>
      isClone(command) ? spawn.clone(command) : spawn.gitVersion,
    );
    spawn.calls = scripted.calls;
    spawn.killed = scripted.killed;
    const runtime = testRuntime();
    const runPromiseExit = runtime.runPromiseExit.bind(runtime);
    runtimeSpy = vi
      .spyOn(runtime, 'runPromiseExit')
      .mockImplementation((program, options) =>
        runPromiseExit(program.pipe(Effect.provide(scripted.layer)), {
          ...options,
          signal: options?.signal ?? hostAbort?.signal,
        }),
      );
    mocks.getSecret.mockReturnValue(Effect.succeed('olp_secret'));
    mocks.readCliAmbientState.mockReturnValue({
      isCi: false,
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
      termIsDumb: false,
      stdoutColorEnabled: false,
      stderrColorEnabled: false,
    });
    mocks.setSecret.mockReturnValue(Effect.void);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    runtimeSpy.mockRestore();
    hostAbort = undefined;
  });

  it('clones into --cwd with a stored token and emits structured output', async () => {
    const result = await runCli([
      'clone',
      PROJECT_ID,
      '--cwd',
      workspacePath,
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Success);
    // The platform-less handoff itself: clone opens no global state store and
    // no global-root handle, so it holds the event loop open past nothing.
    expect(mocks.installCliProcessRuntime).toHaveBeenCalledWith(undefined, {
      ...NO_PLATFORM_INSTALL,
      minimumLogLevel: 'Info',
    });
    expect(mocks.getSecret).toHaveBeenCalledWith('overleaf.gitToken');
    expectClonedInto(workspacePath);
    expect(JSON.parse(stdout)).toEqual({
      cloned: true,
      provider: 'overleaf',
      host: 'git.overleaf.com',
      destination: workspacePath,
    });
    expect(`${stdout}${stderr}`).not.toContain('olp_secret');
  });

  it('creates and clones into a relative positional destination', async () => {
    const destination = path.join(workspacePath, 'resobabce');
    const result = await withProcessCwd(workspacePath, () =>
      runCli([
        'clone',
        'https://git@git.overleaf.com/0123456789abcdef01234567',
        'resobabce',
        '--output-format',
        'json',
        '--no-input',
      ]),
    );

    expect(result.exitCode).toBe(CliExitCode.Success);
    expectClonedInto(destination);
    expect(JSON.parse(stdout)).toMatchObject({
      cloned: true,
      destination: destination,
    });
  });

  it('stops the Git process when the host interrupts cloning', async () => {
    const controller = new AbortController();
    hostAbort = controller;
    spawn.clone = () => {
      queueMicrotask(() => controller.abort());
      return 'hang';
    };

    const result = await runCli([
      'clone',
      PROJECT_ID,
      '--cwd',
      workspacePath,
      '--output-format',
      'json',
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Interrupted);

    expect(cloneCalls()).toHaveLength(1);
    expect(spawn.killed.filter(isClone)).toHaveLength(1);
    expect(stdout).not.toContain('"cloned":true');
  });

  it('does not create a positional destination when the token is missing', async () => {
    mocks.getSecret.mockReturnValue(Effect.succeed(undefined));
    const destination = path.join(workspacePath, 'missing-token');
    const result = await withProcessCwd(workspacePath, () =>
      runCli(['clone', PROJECT_ID, 'missing-token', '--no-input']),
    );

    expect(result.exitCode).toBe(CliExitCode.Usage);
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(cloneCalls()).toHaveLength(0);
  });

  it('does not create a positional destination when Git is unavailable', async () => {
    spawn.gitVersion = { stderr: 'git not found', exitCode: 127 };
    const destination = path.join(workspacePath, 'missing-git');
    const result = await withProcessCwd(workspacePath, () =>
      runCli(['clone', PROJECT_ID, 'missing-git', '--no-input']),
    );

    expect(result.exitCode).toBe(CliExitCode.AgentError);
    expect(stderr).toContain('Git is not installed or is not on PATH.');
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(cloneCalls()).toHaveLength(0);
  });

  it('rejects ambiguous positional and --cwd destinations', async () => {
    const result = await runCli([
      'clone',
      PROJECT_ID,
      path.join(workspacePath, 'positional'),
      '--cwd',
      workspacePath,
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Usage);
    expect(stderr).toContain(
      'either as the second argument or with --cwd, not both',
    );
    expect(mocks.getSecret).not.toHaveBeenCalled();
    expect(cloneCalls()).toHaveLength(0);
  });

  it.each([
    { mode: 'headless', extraArgs: ['--no-input'] },
    { mode: 'machine-readable', extraArgs: ['--output-format', 'json'] },
  ])(
    'does not prompt for a missing token in $mode mode',
    async ({ extraArgs }) => {
      mocks.getSecret.mockReturnValue(Effect.succeed(undefined));

      const result = await runCli([
        'clone',
        PROJECT_ID,
        '--cwd',
        workspacePath,
        ...extraArgs,
      ]);

      expect(result.exitCode).toBe(CliExitCode.Usage);
      expect(stderr).toContain('No saved Overleaf Git Token is available.');
      expect(stderr).toContain('https://www.overleaf.com/user/settings');
      expect(stderr).toContain('git-integration-authentication-tokens');
      expect(cloneCalls()).toHaveLength(0);
    },
  );

  it('rejects invalid project identifiers before reading credentials', async () => {
    const result = await runCli([
      'clone',
      'not-a-project',
      '--cwd',
      workspacePath,
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Usage);
    expect(stderr).toContain('Invalid Overleaf/ShareLaTeX project.');
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it('refuses to clone into a nonempty destination', async () => {
    await writeFile(path.join(workspacePath, 'paper.tex'), 'source');
    const canonicalWorkspacePath = canonicalizeWorkspacePath(workspacePath);

    const result = await runCli([
      'clone',
      PROJECT_ID,
      '--cwd',
      workspacePath,
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.AgentError);
    expect(stderr).toContain(`destination directory ${canonicalWorkspacePath}`);
    expect(stderr).toContain('texra clone 0123456789abcdef01234567 ./paper');
    expect(cloneCalls()).toHaveLength(0);
  });

  it('clears rejected credentials without printing them', async () => {
    spawn.clone = () => ({
      stderr:
        "fatal: Authentication failed for 'https://git.overleaf.com/0123456789abcdef01234567/'",
      exitCode: 128,
    });

    const result = await runCli([
      'clone',
      PROJECT_ID,
      '--cwd',
      workspacePath,
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.AgentError);
    expect(mocks.deleteSecret).toHaveBeenCalledWith('overleaf.gitToken');
    expect(stderr).toContain('Clone failed: authentication error.');
    expect(`${stdout}${stderr}`).not.toContain('olp_secret');
  });
});
