// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeAll, describe, expect } from 'vitest';

// Local imports
import { scanDirectory } from '@agent/index/agentYamlScanner';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

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

/** The temp directory as an Effect, so the scan reads real files on disk. */
const agentDir = (files: Record<string, readonly string[]>) =>
  Effect.promise(() => createAgentDir(files));

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

  it.live(
    'derives workflow round counts from inherited settings and prompts',
    () =>
      Effect.gen(function* () {
        const dir = yield* agentDir({
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

        const { entries } = yield* scanDirectory(dir, 'custom');

        expect(entries.find((entry) => entry.name === 'child')?.rounds).toBe(4);
        expect(
          entries.find((entry) => entry.name === 'prompt-child')?.rounds,
        ).toBe(3);
        expect(
          entries.find((entry) => entry.name === 'missing-parent')?.rounds,
        ).toBeUndefined();
      }),
  );

  it.live('uses the YAML name as the canonical registry name', () =>
    Effect.gen(function* () {
      const dir = yield* agentDir({
        'Readable Helper.yaml': toolUseAgent('helper', 'help'),
      });

      const { entries } = yield* scanDirectory(dir, 'custom');

      expect(entries.map((entry) => entry.name)).toEqual(['helper']);
    }),
  );

  it.live('skips agent names that are not identifiers', () =>
    Effect.gen(function* () {
      const dir = yield* agentDir({
        'review.yaml': [
          'name: review team',
          'description: Verifies manuscripts.',
          'settings:',
          '  agentCategory: toolUse',
          'prompts:',
          '  systemPrompt: review',
        ],
      });

      const { entries } = yield* scanDirectory(dir, 'custom');

      expect(entries).toEqual([]);
    }),
  );

  it.live(
    'skips duplicate YAML names instead of returning colliding entries',
    () =>
      Effect.gen(function* () {
        const dir = yield* agentDir({
          'first.yaml': toolUseAgent('shared', 'first'),
          'second.yaml': toolUseAgent('shared', 'second'),
          'unique.yaml': toolUseAgent('unique', 'unique'),
        });

        const { entries } = yield* scanDirectory(dir, 'custom');

        expect(entries.map((entry) => entry.name)).toEqual(['unique']);
      }),
  );

  it.live('skips a file with malformed YAML instead of throwing', () =>
    Effect.gen(function* () {
      const dir = yield* agentDir({
        'broken.yaml': ['name: "unterminated'],
        'valid.yaml': toolUseAgent('valid', 'hi'),
      });

      const { entries } = yield* scanDirectory(dir, 'custom');

      expect(entries.map((entry) => entry.name)).toEqual(['valid']);
    }),
  );

  it.live('reports skipped custom YAML files as scan issues', () =>
    Effect.gen(function* () {
      const dir = yield* agentDir({
        'broken.yaml': ['name: "unterminated'],
        'retired.yaml': [
          'name: retired',
          'settings:',
          '  agentCategory: workflow',
          '  documentTag: documents',
        ],
        'valid.yaml': toolUseAgent('valid', 'hi'),
      });

      const { entries, issues } = yield* scanDirectory(dir, 'custom');

      expect(entries.map((entry) => entry.name)).toEqual(['valid']);
      expect(issues).toEqual([
        expect.objectContaining({
          path: 'broken.yaml',
          message: expect.stringMatching(/unterminated|Nested mappings|YAML/iu),
        }),
        expect.objectContaining({
          path: 'retired.yaml',
          message: expect.stringContaining('documentTag'),
        }),
      ]);
    }),
  );
});
