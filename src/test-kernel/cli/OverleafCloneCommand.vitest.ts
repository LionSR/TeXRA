// Node imports
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { NO_PLATFORM_INSTALL } from '@cli/runtime/cliProcessRuntime';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { overleafGitClone } from '@latex/overleafProject';
import { testRuntime } from '@test/support/testProcessRuntime';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
import { canonicalizeWorkspacePath } from '@utils/system/nodeWorkspace';
import { makeMachineGitEnv } from '@utils/system/gitEnv';
import type * as ChildProcess from 'effect/process/ChildProcess';

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
  mocks.installCliProcessRuntime.mockImplementation(() => testRuntime());
  return {
    ...actual,
    installCliProcessRuntime: mocks.installCliProcessRuntime,
    disposeCliProcessRuntime: EffectModule.void,
  };
});

vi.mock('@cli/runtime/cliSecrets', () => ({
  cliSecrets: () => ({
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
 * The clone ran in the C locale against the tokenless remote with the token
 * only in the helper's environment, then offered it to the user's credential
 * helper.
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
    env: { ...makeMachineGitEnv(), ...clone.env, LC_ALL: 'C', LANGUAGE: 'C' },
    extendEnv: false,
  });
  const approve = spawn.calls.find((call) => call.args[0] === 'credential');
  expect(approve?.args).toEqual(['credential', 'approve']);
  expect(approve?.options).toMatchObject({ cwd, extendEnv: false });
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
    mocks.installCliProcessRuntime.mockImplementation(() => testRuntime());
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
    expect(mocks.installCliProcessRuntime).toHaveBeenCalledWith(
      defaultNodeStorageRoot(),
      {
        ...NO_PLATFORM_INSTALL,
        minimumLogLevel: 'Info',
      },
    );
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
