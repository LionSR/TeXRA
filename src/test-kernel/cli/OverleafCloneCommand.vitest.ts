// Node imports
import { access, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { CliExitCode } from '@cli/runtime/exitCodes';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { extendEnvPath } from '@utils/system/platformPaths';

const mocks = vi.hoisted(() => ({
  deleteSecret: vi.fn(),
  execa: vi.fn(),
  executeCommandSync: vi.fn(),
  getSecret: vi.fn(),
  readCliAmbientState: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock('execa', () => ({ execa: mocks.execa }));

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

vi.mock('@utils/system/execUtils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@utils/system/execUtils')>()),
  executeCommandSync: mocks.executeCommandSync,
}));

const { runCli } = await import('@cli/commands/root');

const PROJECT_ID = '0123456789abcdef01234567';

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
    mocks.deleteSecret.mockResolvedValue(undefined);
    mocks.execa.mockResolvedValue({});
    mocks.executeCommandSync.mockReturnValue({
      success: true,
      exitCode: 0,
      stdout: 'git version 2.50.0',
      stderr: '',
    });
    mocks.getSecret.mockResolvedValue('olp_secret');
    mocks.readCliAmbientState.mockReturnValue({
      isCi: false,
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
      termIsDumb: false,
      stdoutColorEnabled: false,
      stderrColorEnabled: false,
    });
    mocks.setSecret.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
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
    expect(mocks.getSecret).toHaveBeenCalledWith('overleaf.gitToken');
    expect(mocks.execa).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        'https://git:olp_secret@git.overleaf.com/0123456789abcdef01234567',
        '.',
      ],
      {
        cwd: workspacePath,
        env: { GIT_TERMINAL_PROMPT: '0', PATH: extendEnvPath() },
      },
    );
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
    expect(mocks.execa).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        'https://git:olp_secret@git.overleaf.com/0123456789abcdef01234567',
        '.',
      ],
      {
        cwd: destination,
        env: { GIT_TERMINAL_PROMPT: '0', PATH: extendEnvPath() },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      cloned: true,
      destination: destination,
    });
  });

  it('does not create a positional destination when the token is missing', async () => {
    mocks.getSecret.mockResolvedValue(undefined);
    const destination = path.join(workspacePath, 'missing-token');
    const result = await withProcessCwd(workspacePath, () =>
      runCli(['clone', PROJECT_ID, 'missing-token', '--no-input']),
    );

    expect(result.exitCode).toBe(CliExitCode.Usage);
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('does not create a positional destination when Git is unavailable', async () => {
    mocks.executeCommandSync.mockReturnValue({
      success: false,
      exitCode: null,
      stdout: '',
      stderr: 'git not found',
    });
    const destination = path.join(workspacePath, 'missing-git');
    const result = await withProcessCwd(workspacePath, () =>
      runCli(['clone', PROJECT_ID, 'missing-git', '--no-input']),
    );

    expect(result.exitCode).toBe(CliExitCode.AgentError);
    expect(stderr).toContain('Git is not installed or is not on PATH.');
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(mocks.execa).not.toHaveBeenCalled();
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
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'headless', extraArgs: ['--no-input'] },
    { mode: 'machine-readable', extraArgs: ['--output-format', 'json'] },
  ])(
    'does not prompt for a missing token in $mode mode',
    async ({ extraArgs }) => {
      mocks.getSecret.mockResolvedValue(undefined);

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
      expect(mocks.execa).not.toHaveBeenCalled();
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
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('clears rejected credentials without printing them', async () => {
    mocks.execa.mockRejectedValue(
      new Error(
        'fatal: authentication failed for https://git:olp_secret@git.overleaf.com',
      ),
    );

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
