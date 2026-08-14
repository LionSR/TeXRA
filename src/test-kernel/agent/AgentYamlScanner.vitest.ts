// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

// Local imports
import { scanDirectory } from '@agent/index/agentYamlScanner';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { installPlatform } from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';

const tempDirs: string[] = [];

/** Create a temp agent directory holding the given YAML files, given as lines. */
async function createAgentDir(
  files: Record<string, readonly string[]>,
): Promise<string> {
  const agentDir = await makeTempDir('texra-agent-scan-', tempDirs);
  for (const [fileName, lines] of Object.entries(files)) {
    await writeFile(resolve(agentDir, fileName), `${lines.join('\n')}\n`);
  }
  return agentDir;
}

function toolUseAgent(name: string, systemPrompt: string): string[] {
  return [
    `name: ${name}`,
    'settings:',
    '  agentCategory: toolUse',
    'prompts:',
    `  systemPrompt: ${systemPrompt}`,
  ];
}

describe('agent YAML scanner', () => {
  beforeAll(() => installPlatform({}, { fs: nodeFilesystem }));

  afterEach(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('derives workflow round counts from inherited settings and prompts', async () => {
    const agentDir = await createAgentDir({
      'base.yaml': [
        'name: base',
        'settings:',
        '  agentCategory: workflow',
        '  rounds: 4',
        'prompts:',
        '  userRequest: base',
      ],
      'child.yaml': [
        'name: child',
        'inherits: base',
        'prompts:',
        '  userRequest: child',
      ],
      'prompt-base.yaml': [
        'name: prompt-base',
        'settings:',
        '  agentCategory: workflow',
        '  rounds: 1',
        'prompts:',
        '  userRequest:',
        '    - first',
        '    - second',
        '    - third',
      ],
      'prompt-child.yaml': ['name: prompt-child', 'inherits: prompt-base'],
      'missing-parent.yaml': [
        'name: missing-parent',
        'inherits: no-such-parent',
      ],
    });

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.find((entry) => entry.name === 'child')?.rounds).toBe(4);
    expect(entries.find((entry) => entry.name === 'prompt-child')?.rounds).toBe(
      3,
    );
    expect(
      entries.find((entry) => entry.name === 'missing-parent')?.rounds,
    ).toBeUndefined();
  });

  it('uses the YAML name as the canonical registry name', async () => {
    const agentDir = await createAgentDir({
      'Readable Helper.yaml': toolUseAgent('helper', 'help'),
    });

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.map((entry) => entry.name)).toEqual(['helper']);
  });

  it('skips agent names that are not identifiers', async () => {
    const agentDir = await createAgentDir({
      'review.yaml': [
        'name: review team',
        'description: Verifies manuscripts.',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: review',
      ],
    });

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries).toEqual([]);
  });

  it('skips duplicate YAML names instead of returning colliding entries', async () => {
    const agentDir = await createAgentDir({
      'first.yaml': toolUseAgent('shared', 'first'),
      'second.yaml': toolUseAgent('shared', 'second'),
      'unique.yaml': toolUseAgent('unique', 'unique'),
    });

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.map((entry) => entry.name)).toEqual(['unique']);
  });

  it('skips a file with malformed YAML instead of throwing', async () => {
    const agentDir = await createAgentDir({
      'broken.yaml': ['name: "unterminated'],
      'valid.yaml': toolUseAgent('valid', 'hi'),
    });

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.map((entry) => entry.name)).toEqual(['valid']);
  });
});
