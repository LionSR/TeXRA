// Node imports
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { CliExitCode } from '@cli/runtime/exitCodes';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
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

describe('CLI Overleaf clone command', () => {
  let workspacePath: string;
  let stdout: string;
  let stderr: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    workspacePath = await mkdtemp(path.join(tmpdir(), 'texra-clone-'));
    stdout = '';
    stderr = '';
    stdoutSpy = spyOnStreamWrite(process.stdout, (text) => {
      stdout += text;
    });
    stderrSpy = spyOnStreamWrite(process.stderr, (text) => {
      stderr += text;
    });
    mocks.deleteSecret.mockReset().mockResolvedValue(undefined);
    mocks.execa.mockReset().mockResolvedValue({});
    mocks.executeCommandSync.mockReset().mockReturnValue({
      success: true,
      exitCode: 0,
      stdout: 'git version 2.50.0',
      stderr: '',
    });
    mocks.getSecret.mockReset().mockResolvedValue('olp_secret');
    mocks.readCliAmbientState.mockReset().mockReturnValue({
      isCi: false,
      stdinIsTty: true,
      stdoutIsTty: true,
      stderrIsTty: true,
      termIsDumb: false,
      stdoutColorEnabled: false,
      stderrColorEnabled: false,
    });
    mocks.setSecret.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('clones into --cwd with a stored token and emits structured output', async () => {
    const canonicalWorkspacePath = await realpath(workspacePath);
    const result = await runCli([
      'clone',
      '0123456789abcdef01234567',
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
        cwd: canonicalWorkspacePath,
        env: { GIT_TERMINAL_PROMPT: '0', PATH: extendEnvPath() },
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      cloned: true,
      provider: 'overleaf',
      host: 'git.overleaf.com',
      destination: canonicalWorkspacePath,
    });
    expect(`${stdout}${stderr}`).not.toContain('olp_secret');
  });

  it('does not prompt for a missing token in headless mode', async () => {
    mocks.getSecret.mockResolvedValue(undefined);

    const result = await runCli([
      'clone',
      '0123456789abcdef01234567',
      '--cwd',
      workspacePath,
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Usage);
    expect(stderr).toContain('No saved Overleaf Git Token is available.');
    expect(mocks.execa).not.toHaveBeenCalled();
  });

  it('does not prompt for a missing token in machine-readable mode', async () => {
    mocks.getSecret.mockResolvedValue(undefined);

    const result = await runCli([
      'clone',
      '0123456789abcdef01234567',
      '--cwd',
      workspacePath,
      '--output-format',
      'json',
    ]);

    expect(result.exitCode).toBe(CliExitCode.Usage);
    expect(stderr).toContain('No saved Overleaf Git Token is available.');
    expect(mocks.execa).not.toHaveBeenCalled();
  });

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

    const result = await runCli([
      'clone',
      '0123456789abcdef01234567',
      '--cwd',
      workspacePath,
      '--no-input',
    ]);

    expect(result.exitCode).toBe(CliExitCode.AgentError);
    expect(stderr).toContain('destination directory must be empty');
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
      '0123456789abcdef01234567',
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
