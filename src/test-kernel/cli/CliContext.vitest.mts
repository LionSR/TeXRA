import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCliContext,
  CliUsageError,
  resolveCliCwd,
} from '../../../packages/cli/src/runtime/cliContext';
import { loadWorkspaceCliConfig } from '../../../packages/cli/src/runtime/cliConfig';

const ambient = {
  isCi: true,
  stdinIsTty: false,
  stdoutIsTty: false,
  stderrIsTty: false,
  colorEnabled: false,
};

async function workspaceWithConfig(config: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'texra-cli-context-'));
  await mkdir(join(workspace, '.texra'), { recursive: true });
  await writeFile(join(workspace, '.texra', 'config.json'), config);
  return workspace;
}

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
        model: 'claude-opus-4-7',
        chat: { other: true, model: 'deepseekT' },
      }),
    );

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.values.chat?.model).toBe('deepseekT');
    expect(loaded.values.model).toBeUndefined();
    expect(loaded.warnings.join('\n')).toContain('unknown');
    expect(loaded.warnings.join('\n')).toContain('model');
    expect(loaded.warnings.join('\n')).toContain('chat.other');
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
      JSON.stringify({ outputFormat: 'json' }),
    );
    await symlink(workspace, link, 'dir');

    const context = await buildCliContext({
      ambient,
      env: {},
      globalArgs: { cwd: link },
    });

    expect(context.cwd).toBe(await realpath(workspace));
    expect(context.outputFormat).toBe('json');
  });

  it('reports malformed workspace config files without failing', async () => {
    const workspace = await workspaceWithConfig('{');

    const loaded = await loadWorkspaceCliConfig(workspace);

    expect(loaded.values).toEqual({});
    expect(loaded.path).toContain('.texra/config.json');
    expect(loaded.warnings.join('\n')).toContain('Could not parse');
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
      env: { TEXRA_API_MODE: 'direct' },
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
      await realpath(workspace),
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
