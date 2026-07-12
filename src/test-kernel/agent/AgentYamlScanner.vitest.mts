// Standard library imports
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Third-party imports
import { beforeAll, describe, expect, it } from 'vitest';

// Local imports - test setup
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createFakePlatform } from '@test/support/FakePlatform';
import { scanDirectory } from '@agent/index/agentYamlScanner';

describe('agent YAML scanner', () => {
  beforeAll(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
  });

  it('derives workflow round counts from inherited settings and prompts', async () => {
    const agentDir = await mkdtemp(resolve(tmpdir(), 'texra-agent-scan-'));
    await writeFile(
      resolve(agentDir, 'base.yaml'),
      [
        'name: base',
        'settings:',
        '  agentCategory: workflow',
        '  rounds: 4',
        'prompts:',
        '  userRequest: base',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'child.yaml'),
      [
        'name: child',
        'inherits: base',
        'prompts:',
        '  userRequest: child',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'assistant.yaml'),
      [
        'name: assistant',
        'settings:',
        '  agentCategory: workflow',
        '  rounds: 5',
        'prompts:',
        '  userRequest: assistant',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'alias-child.yaml'),
      [
        'name: alias-child',
        'inherits: chat',
        'prompts:',
        '  userRequest: alias child',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'prompt-base.yaml'),
      [
        'name: prompt-base',
        'settings:',
        '  agentCategory: workflow',
        '  rounds: 1',
        'prompts:',
        '  userRequest:',
        '    - first',
        '    - second',
        '    - third',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'prompt-child.yaml'),
      ['name: prompt-child', 'inherits: prompt-base', ''].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'missing-parent.yaml'),
      ['name: missing-parent', 'inherits: no-such-parent', ''].join('\n'),
    );

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.find((entry) => entry.name === 'child')?.rounds).toBe(4);
    expect(entries.find((entry) => entry.name === 'alias-child')?.rounds).toBe(
      5,
    );
    expect(entries.find((entry) => entry.name === 'prompt-child')?.rounds).toBe(
      3,
    );
    expect(
      entries.find((entry) => entry.name === 'missing-parent')?.rounds,
    ).toBeUndefined();
  });

  it('uses the YAML name as the canonical registry name', async () => {
    const agentDir = await mkdtemp(resolve(tmpdir(), 'texra-agent-scan-'));
    await writeFile(
      resolve(agentDir, 'Readable Helper.yaml'),
      [
        'name: helper',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: help',
        '',
      ].join('\n'),
    );

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.map((entry) => entry.name)).toEqual(['helper']);
  });

  it('skips agent names that are not identifiers', async () => {
    const agentDir = await mkdtemp(resolve(tmpdir(), 'texra-agent-scan-'));
    await writeFile(
      resolve(agentDir, 'review.yaml'),
      [
        'name: review team',
        'description: Verifies manuscripts.',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: review',
        '',
      ].join('\n'),
    );

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries).toEqual([]);
  });

  it('skips duplicate YAML names instead of returning colliding entries', async () => {
    const agentDir = await mkdtemp(resolve(tmpdir(), 'texra-agent-scan-'));
    await writeFile(
      resolve(agentDir, 'first.yaml'),
      [
        'name: shared',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: first',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'second.yaml'),
      [
        'name: shared',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: second',
        '',
      ].join('\n'),
    );
    await writeFile(
      resolve(agentDir, 'unique.yaml'),
      [
        'name: unique',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: unique',
        '',
      ].join('\n'),
    );

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.map((entry) => entry.name)).toEqual(['unique']);
  });

  it('skips a file with malformed YAML instead of throwing', async () => {
    const agentDir = await mkdtemp(resolve(tmpdir(), 'texra-agent-scan-'));
    await writeFile(resolve(agentDir, 'broken.yaml'), 'name: "unterminated\n');
    await writeFile(
      resolve(agentDir, 'valid.yaml'),
      [
        'name: valid',
        'settings:',
        '  agentCategory: toolUse',
        'prompts:',
        '  systemPrompt: hi',
        '',
      ].join('\n'),
    );

    const entries = await scanDirectory(agentDir, 'custom');

    expect(entries.map((entry) => entry.name)).toEqual(['valid']);
  });
});
