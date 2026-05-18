import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildCliContext } from '../../../packages/cli/src/runtime/cliContext';
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
        globalArgs: { cwd: '/tmp/no-such-texra-workspace' },
      }),
    ).resolves.toMatchObject({
      outputFormat: 'text',
      approvalPolicy: 'never',
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
      globalArgs: { cwd: '/tmp/no-such-texra-workspace' },
    });

    expect(context.envModel).toBeUndefined();
    expect(context.configWarnings?.join('\n')).toContain('TEXRA_MODEL');
  });
});
