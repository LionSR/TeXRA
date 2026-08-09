import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCliContext,
  CliUsageError,
  isTexraCliEntrypointPath,
  readCliBugsUrl,
  readCliEnv,
  readCliVersion,
  resolveCliCwd,
  resolveCliCommandName,
  resolveStreamColor,
  type CliAmbientState,
} from '@cli/runtime/cliContext';
import { loadWorkspaceCliConfig } from '@cli/runtime/cliConfig';
import { canonicalizeWorkspacePath } from '@platform/defaults/nodeWorkspace';

const ambient = {
  isCi: true,
  stdinIsTty: false,
  stdoutIsTty: false,
  stderrIsTty: false,
  stdoutColorEnabled: false,
  stderrColorEnabled: false,
};

function ttyAmbient(overrides: Partial<CliAmbientState> = {}): CliAmbientState {
  return {
    isCi: false,
    stdinIsTty: true,
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    ...overrides,
  };
}

async function workspaceWithConfig(config: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'texra-cli-context-'));
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(join(workspace, '.texra', 'config.json'), config);
  return workspace;
}

describe('CLI entrypoint detection', () => {
  it('recognizes published and local TeXRA launchers', () => {
    expect(isTexraCliEntrypointPath('/usr/local/bin/texra')).toBe(true);
    expect(isTexraCliEntrypointPath('/tmp/bin/texra-local')).toBe(true);
    expect(
      isTexraCliEntrypointPath('/repo/packages/cli/dist/bin/texra.js'),
    ).toBe(true);
    expect(
      isTexraCliEntrypointPath('/repo/packages/cli/src/bin/texra.ts'),
    ).toBe(true);
    expect(isTexraCliEntrypointPath('/usr/local/bin/vitest')).toBe(false);
  });

  it('uses the local launcher name in user-facing command hints', () => {
    expect(resolveCliCommandName('/usr/local/bin/texra')).toBe('texra');
    expect(resolveCliCommandName('/tmp/bin/texra-local')).toBe('texra-local');
    expect(resolveCliCommandName('/repo/packages/cli/dist/bin/texra.js')).toBe(
      'texra',
    );
  });
});

describe('CLI package manifest discovery', () => {
  it('finds version and bug-report metadata from the source runtime layout', async () => {
    await expect(readCliVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/);
    await expect(readCliBugsUrl()).resolves.toBe(
      'https://github.com/texra-ai/texra-issues/issues',
    );
  });
});

describe('CLI env boundary', () => {
  it('returns a snapshot for environment reads', () => {
    process.env.TEXRA_READ_ENV_TEST = 'original';
    try {
      const env = readCliEnv();
      env.TEXRA_READ_ENV_TEST = 'mutated';
      expect(process.env.TEXRA_READ_ENV_TEST).toBe('original');
    } finally {
      delete process.env.TEXRA_READ_ENV_TEST;
    }
  });
});

describe('CLI context config defaults', () => {
  it('applies flag over env over workspace config over built-in defaults', async () => {
    const workspace = await workspaceWithConfig(
      JSON.stringify({
        outputFormat: 'json',
        approvalPolicy: 'ask',
      }),
    );

    await expect(
      buildCliContext({
        ambient,
        env: { TEXRA_OUTPUT_FORMAT: 'ndjson' },
        globalArgs: { cwd: workspace },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'ndjson',
      approvalPolicy: 'ask',
    });

    await expect(
      buildCliContext({
        ambient,
        env: { TEXRA_OUTPUT_FORMAT: 'ndjson' },
        globalArgs: { cwd: workspace, outputFormat: 'text' },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'text',
      approvalPolicy: 'ask',
    });

    await expect(
      buildCliContext({
        ambient,
        env: {},
        globalArgs: { cwd: tmpdir() },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'text',
      approvalPolicy: 'ask',
    });
  });

  it('reports unknown and invalid workspace config fields without failing', async () => {
    const workspace = await workspaceWithConfig(
      JSON.stringify({
        unknown: true,
        'texra.model': 'claude-opus-4-7',
        'texra.chat': { other: true, model: 'deepseekT' },
      }),
    );

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.values.chat?.model).toBe('deepseekT');
    expect(loaded.values.model).toBeUndefined();
    expect(loaded.warnings.join('\n')).toContain('unknown');
    expect(loaded.warnings.join('\n')).toContain('model');
    expect(loaded.warnings.join('\n')).toContain('chat.other');
  });

  it('accepts the CLI-only ChatGPT Codex preference key', async () => {
    const workspace = await workspaceWithConfig(
      JSON.stringify({
        'texra.chatgptCodex.preferSubscription': true,
      }),
    );

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.warnings).toEqual([]);
  });

  it('accepts prefixed command sections from unified workspace config', async () => {
    const workspace = await workspaceWithConfig(
      JSON.stringify({
        'texra.agent': 'generic',
        'texra.model': 'gpt55',
        'texra.chat': { agent: 'chat', model: 'deepseekT' },
        'texra.run': { agent: 'criticize', model: 'sonnet46T' },
      }),
    );

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.values.agent).toBe('generic');
    expect(loaded.values.model).toBe('gpt55');
    expect(loaded.values.chat).toEqual({
      agent: 'chat',
      model: 'deepseekT',
    });
    expect(loaded.values.run).toEqual({
      agent: 'criticize',
      model: 'sonnet46T',
    });
    expect(loaded.warnings).toEqual([]);
  });

  it('canonicalizes existing workspace paths before reading config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'texra-cli-context-link-'));
    const workspace = join(root, 'workspace');
    const link = join(root, 'linked-workspace');
    await mkdir(join(workspace, '.texra'), { recursive: true });
    await writeFile(
      join(workspace, '.texra', 'config.json'),
      JSON.stringify({ 'texra.outputFormat': 'json' }),
    );
    await symlink(workspace, link, 'dir');

    const context = await buildCliContext({
      ambient,
      env: {},
      globalArgs: { cwd: link },
    });

    expect(context.cwd).toBe(canonicalizeWorkspacePath(workspace));
    expect(context.outputFormat).toBe('json');
  });

  it('reports malformed workspace config files without failing', async () => {
    const workspace = await workspaceWithConfig('{');

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.values).toEqual({});
    expect(loaded.path).toContain(join('.texra', 'config.json'));
    expect(loaded.warnings.join('\n')).toContain('Could not parse');
  });

  it('reports unreadable workspace config files without treating them as absent', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-cli-context-'));
    await mkdir(join(workspace, '.texra', 'config.json'), {
      recursive: true,
    });

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.values).toEqual({});
    expect(loaded.path).toContain(join('.texra', 'config.json'));
    expect(loaded.warnings.join('\n')).toContain('Could not read');
  });

  it('ignores unknown TEXRA_MODEL values before they reach runtime', async () => {
    const context = await buildCliContext({
      ambient,
      env: { TEXRA_MODEL: 'claude-opus-4-7' },
      globalArgs: { cwd: tmpdir() },
    });

    expect(context.envModel).toBeUndefined();
    expect(context.configWarnings?.join('\n')).toContain('TEXRA_MODEL');
  });

  it('parses TEXRA_API_MODE aliases before runtime initialization', async () => {
    const context = await buildCliContext({
      ambient,
      env: { TEXRA_API_MODE: 'byok' },
      globalArgs: { cwd: tmpdir() },
    });

    expect(context.apiMode).toBe('personal');
  });

  it('lets --api-mode override TEXRA_API_MODE', async () => {
    const context = await buildCliContext({
      ambient,
      env: { TEXRA_API_MODE: 'personal' },
      globalArgs: {
        apiMode: 'included',
        cwd: tmpdir(),
      },
    });

    expect(context.apiMode).toBe('included');
  });

  it('rejects invalid explicit --api-mode values', async () => {
    await expect(
      buildCliContext({
        ambient,
        env: { TEXRA_API_MODE: 'included' },
        globalArgs: {
          apiMode: 'unknown-mode',
          cwd: tmpdir(),
        },
      }),
    ).rejects.toThrow('Invalid value for argument: --api-mode');
  });

  it('reports invalid TEXRA_API_MODE values without failing', async () => {
    const context = await buildCliContext({
      ambient,
      env: { TEXRA_API_MODE: 'unknown-mode' },
      globalArgs: { cwd: tmpdir() },
    });

    expect(context.apiMode).toBeUndefined();
    expect(context.configWarnings?.join('\n')).toContain('TEXRA_API_MODE');
  });
});

describe('CLI --cwd validation', () => {
  it('accepts an existing directory and returns its realpath', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-cli-cwd-'));

    await expect(resolveCliCwd(workspace)).resolves.toBe(
      canonicalizeWorkspacePath(workspace),
    );
  });

  it('rejects a --cwd path that does not exist', async () => {
    const missing = join(tmpdir(), 'texra-cli-cwd-missing-' + Date.now());

    await expect(resolveCliCwd(missing)).rejects.toBeInstanceOf(CliUsageError);
    await expect(resolveCliCwd(missing)).rejects.toThrow(/does not exist/);
  });

  it('rejects a --cwd path that points at a file', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'texra-cli-cwd-'));
    const filePath = join(workspace, 'config.json');
    await writeFile(filePath, '{}');

    await expect(resolveCliCwd(filePath)).rejects.toBeInstanceOf(CliUsageError);
    await expect(resolveCliCwd(filePath)).rejects.toThrow(/not a directory/);
  });

  it('falls back to process.cwd() when no --cwd flag is given', async () => {
    // The shell can't put us in a missing directory, so the no-flag path
    // intentionally skips validation. Trim any platform realpath canonical-
    // ization for the comparison.
    const result = await resolveCliCwd(undefined);
    expect(result).toBe(await realpath(process.cwd()));
  });

  it('lets a buildCliContext caller surface the --cwd usage error', async () => {
    const missing = join(tmpdir(), 'texra-cli-cwd-missing-' + Date.now());

    await expect(
      buildCliContext({ ambient, env: {}, globalArgs: { cwd: missing } }),
    ).rejects.toBeInstanceOf(CliUsageError);
  });
});

describe('CLI per-stream color resolution', () => {
  it.each([
    {
      label: 'colors when the stream itself is a TTY',
      isTty: true,
      options: { env: {} },
      expected: true,
    },
    {
      label: 'stays plain when the stream itself is not a TTY',
      isTty: false,
      options: { env: {} },
      expected: false,
    },
    {
      label: 'NO_COLOR disables color even on a TTY',
      isTty: true,
      options: { env: { NO_COLOR: '1' } },
      expected: false,
    },
    {
      label: 'empty NO_COLOR still disables color',
      isTty: true,
      options: { env: { NO_COLOR: '' } },
      expected: false,
    },
    {
      label: 'TERM=dumb disables color even on a TTY',
      isTty: true,
      options: { env: { TERM: 'dumb' } },
      expected: false,
    },
    {
      label: 'FORCE_COLOR enables color even off a TTY',
      isTty: false,
      options: { env: { FORCE_COLOR: '1' } },
      expected: true,
    },
    {
      label: 'FORCE_COLOR=true enables color even off a TTY',
      isTty: false,
      options: { env: { FORCE_COLOR: 'true' } },
      expected: true,
    },
    {
      label: 'FORCE_COLOR=0 disables color even on a TTY',
      isTty: true,
      options: { env: { FORCE_COLOR: '0' } },
      expected: false,
    },
    {
      label: 'FORCE_COLOR=false disables color even on a TTY',
      isTty: true,
      options: { env: { FORCE_COLOR: 'false' } },
      expected: false,
    },
    {
      label: 'FORCE_COLOR=no disables color even on a TTY',
      isTty: true,
      options: { env: { FORCE_COLOR: 'no' } },
      expected: false,
    },
    {
      label: 'empty FORCE_COLOR does not force color off a TTY',
      isTty: false,
      options: { env: { FORCE_COLOR: '' } },
      expected: false,
    },
    {
      label: 'NO_COLOR wins over FORCE_COLOR',
      isTty: true,
      options: { env: { FORCE_COLOR: '1', NO_COLOR: '1' } },
      expected: false,
    },
    {
      label: 'forceDisable beats everything',
      isTty: true,
      options: { forceDisable: true, env: { FORCE_COLOR: '1' } },
      expected: false,
    },
  ])('$label', ({ isTty, options, expected }) => {
    expect(resolveStreamColor(isTty, options)).toBe(expected);
  });
});

describe('CLI color/no-input flag wiring', () => {
  it('keeps the ambient per-stream gates by default', async () => {
    const context = await buildCliContext({
      ambient: ttyAmbient({
        stdoutColorEnabled: true,
        stderrColorEnabled: false,
      }),
      env: {},
      globalArgs: { cwd: tmpdir() },
    });
    expect(context.stdoutColorEnabled).toBe(true);
    expect(context.stderrColorEnabled).toBe(false);
  });

  it('--no-color force-disables both stream gates', async () => {
    const context = await buildCliContext({
      ambient: ttyAmbient(),
      env: {},
      globalArgs: { cwd: tmpdir(), noColor: true },
    });
    expect(context.stdoutColorEnabled).toBe(false);
    expect(context.stderrColorEnabled).toBe(false);
  });

  it('--no-input forces headless mode and defaults approval policy to never', async () => {
    const context = await buildCliContext({
      // stdin is a TTY, so without --no-input this would be interactive.
      ambient: ttyAmbient(),
      env: {},
      globalArgs: { cwd: tmpdir(), noInput: true },
    });
    expect(context.mode).toBe('headless');
    expect(context.approvalPolicy).toBe('never');
  });

  it('--no-input preserves explicit approval policy', async () => {
    const context = await buildCliContext({
      ambient: ttyAmbient(),
      env: {},
      globalArgs: { cwd: tmpdir(), noInput: true, approvalPolicy: 'yolo' },
    });
    expect(context.mode).toBe('headless');
    expect(context.approvalPolicy).toBe('yolo');
  });

  it('--no-input ignores env and config approval defaults', async () => {
    const workspace = await workspaceWithConfig(
      JSON.stringify({ approvalPolicy: 'yolo' }),
    );
    const context = await buildCliContext({
      ambient: ttyAmbient(),
      env: { TEXRA_APPROVAL_POLICY: 'yolo' },
      globalArgs: { cwd: workspace, noInput: true },
    });
    expect(context.mode).toBe('headless');
    expect(context.approvalPolicy).toBe('never');
  });

  it('leaves approval policy alone when --no-input is absent', async () => {
    const context = await buildCliContext({
      ambient: ttyAmbient(),
      env: {},
      globalArgs: { cwd: tmpdir(), approvalPolicy: 'yolo' },
    });
    expect(context.mode).toBe('interactive');
    expect(context.approvalPolicy).toBe('yolo');
  });
});
