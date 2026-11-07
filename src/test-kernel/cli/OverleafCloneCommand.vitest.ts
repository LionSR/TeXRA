// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach, beforeEach, expect, vi } from 'vitest';

// Local imports
import { makeMachineGitEnv } from '@texra-ai/harness/node';
import { Secrets } from '@texra-ai/harness/host';
import { NO_PLATFORM_INSTALL } from '@cli/runtime/cliProcessRuntime';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { overleafGitClone } from '@latex/overleafProject';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { SessionGraph } from '@test/support/testKernel';
import { defaultNodeStorageRoot } from '@texra/platform/defaults/nodeStorage';
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
// block's runtime, and the install itself is a spy, so the suite can assert
// what the entry hands it — `NO_PLATFORM_INSTALL`, the real one, spread in
// from the module below. Dropping that argument is what would open the global
// root's handle and hold the event loop past clone's own exit.
vi.mock('@cli/runtime/cliProcessRuntime', async (importOriginal) => {
  const { Effect: EffectModule } = await import('effect');
  const actual =
    await importOriginal<typeof import('@cli/runtime/cliProcessRuntime')>();
  return {
    ...actual,
    installCliProcessRuntime: mocks.installCliProcessRuntime,
    disposeCliProcessRuntime: EffectModule.void,
  };
});

vi.mock('@cli/runtime/cliContext', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/cliContext')>()),
  readCliAmbientState: mocks.readCliAmbientState,
}));

const { runCli } = await import('@cli/commands/root');

const PROJECT_ID = '0123456789abcdef01234567';

type Answer = ReturnType<Parameters<typeof scriptedSpawnerLayer>[0]>;

/**
 * The process edge, scripted: `git --version` answers with `gitVersion`, the
 * clone with `clone`. Every program the entry's runtime runs gets the
 * scripted spawner innermost, so nothing is spawned.
 */
const spawn: {
  gitVersion: Answer;
  clone: (command: ChildProcess.StandardCommand) => Answer;
  calls: ChildProcess.StandardCommand[];
} = { gitVersion: {}, clone: () => ({}), calls: [] };

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
const expectClonedInto = (cwd: string) =>
  Effect.map(makeMachineGitEnv, (machineEnv) => {
    const clone = overleafGitClone(
      { host: 'git.overleaf.com', path: `/${PROJECT_ID}`, isOverleaf: true },
      'olp_secret',
    );
    const [command] = cloneCalls();
    expect(command?.args).toEqual(clone.args);
    expect(command?.options).toMatchObject({
      cwd,
      env: {
        ...machineEnv,
        ...clone.env,
        LC_ALL: 'C',
        LANGUAGE: 'C',
      },
      extendEnv: false,
    });
    const approve = spawn.calls.find((call) => call.args[0] === 'credential');
    expect(approve?.args).toEqual(['credential', 'approve']);
    expect(approve?.options).toMatchObject({ cwd, extendEnv: false });
  });

// Live clock: the entry and its scripted processes run in real time.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'CLI Overleaf clone command',
  (it) => {
    const tempDirs = useTempDirs();
    let workspacePath: string;
    let stdout: string;
    let stderr: string;
    let stdoutSpy: ReturnType<typeof vi.spyOn>;
    let stderrSpy: ReturnType<typeof vi.spyOn>;
    let scripted: ReturnType<typeof scriptedSpawnerLayer>;

    /**
     * The block's runtime as the entry installs it, every program it runs
     * given the scripted spawner and the store the clone caches its token in
     * innermost, as the runtime would serve them.
     */
    const useCliRuntime = Effect.gen(function* () {
      const runtime = yield* SessionGraph.runtime;
      const runPromiseExit = runtime.runPromiseExit.bind(runtime);
      const runtimeSpy = vi
        .spyOn(runtime, 'runPromiseExit')
        .mockImplementation((program, options) =>
          runPromiseExit(
            program.pipe(
              Effect.provide(
                Layer.merge(
                  scripted.layer,
                  Layer.mock(Secrets, {
                    get: mocks.getSecret,
                    delete: mocks.deleteSecret,
                    set: mocks.setSecret,
                  }),
                ),
              ),
            ),
            options,
          ),
        );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => runtimeSpy.mockRestore()),
      );
      mocks.installCliProcessRuntime.mockImplementation(() => runtime);
    });

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
      mocks.deleteSecret.mockReturnValue(Effect.void);
      spawn.gitVersion = { stdout: 'git version 2.50.0' };
      spawn.clone = () => ({});
      scripted = scriptedSpawnerLayer((command) =>
        isClone(command) ? spawn.clone(command) : spawn.gitVersion,
      );
      spawn.calls = scripted.calls;
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
    });

    it.effect(
      'clones into --cwd with a stored token and emits structured output',
      () =>
        Effect.gen(function* () {
          yield* useCliRuntime;
          const result = yield* Effect.promise(() =>
            runCli([
              'clone',
              PROJECT_ID,
              '--cwd',
              workspacePath,
              '--output-format',
              'json',
              '--no-input',
            ]),
          );

          expect(result.exitCode).toBe(CliExitCode.Success);
          // The platform-less handoff itself: clone opens no global state
          // store and no global-root handle, so it holds the event loop open
          // past nothing.
          expect(mocks.installCliProcessRuntime).toHaveBeenCalledWith(
            defaultNodeStorageRoot(),
            {
              ...NO_PLATFORM_INSTALL,
              resourcesPath: expect.any(String),
              minimumLogLevel: 'Info',
            },
          );
          yield* expectClonedInto(workspacePath);
          expect(JSON.parse(stdout)).toEqual({
            cloned: true,
            provider: 'overleaf',
            host: 'git.overleaf.com',
            destination: workspacePath,
          });
          expect(`${stdout}${stderr}`).not.toContain('olp_secret');
        }),
    );

    it.effect('clears rejected credentials without printing them', () =>
      Effect.gen(function* () {
        yield* useCliRuntime;
        spawn.clone = () => ({
          stderr:
            "fatal: Authentication failed for 'https://git.overleaf.com/0123456789abcdef01234567/'",
          exitCode: 128,
        });

        const result = yield* Effect.promise(() =>
          runCli(['clone', PROJECT_ID, '--cwd', workspacePath, '--no-input']),
        );

        expect(result.exitCode).toBe(CliExitCode.AgentError);
        expect(mocks.deleteSecret).toHaveBeenCalledWith('overleaf.gitToken');
        expect(`${stdout}${stderr}`).not.toContain('olp_secret');
      }),
    );
  },
);
