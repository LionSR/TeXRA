// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeAll, describe, expect } from 'vitest';

// Local imports
import { scanDirectory } from '@agent/index/agentYamlScanner';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
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

/** The scan on the process filesystem it now reads its YAML through. */
const scanCustom = (dir: string) =>
  scanDirectory([dir], 'custom').pipe(Effect.provide(nodePlatformLayer));

function toolUseAgent(name: string, systemPrompt: string): string[] {
  return [`name: ${name}`, `prompt: ${systemPrompt}`];
}

describe('agent YAML scanner', () => {
  beforeAll(() => installPlatform({}));

  it.live(
    'refuses a file that still names a parent, saying inherits was removed',
    () =>
      Effect.gen(function* () {
        const dir = yield* agentDir({
          'base.yaml': ['name: base', 'task:', '  requests: [first, second]'],
          'child.yaml': ['name: child', 'inherits: base'],
        });

        const { entries, issues } = yield* scanCustom(dir);

        expect(entries.map((entry) => [entry.name, entry.rounds])).toEqual([
          ['base', 2],
        ]);
        expect(issues).toEqual([
          {
            path: 'child.yaml',
            message: expect.stringContaining(
              '`inherits` was removed in 1.0; copy the fields you need into this agent',
            ),
          },
        ]);
      }),
  );

  it.live('uses the YAML name as the canonical registry name', () =>
    Effect.gen(function* () {
      const dir = yield* agentDir({
        'Readable Helper.yaml': toolUseAgent('helper', 'help'),
      });

      const { entries } = yield* scanCustom(dir);

      expect(entries.map((entry) => entry.name)).toEqual(['helper']);
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

        const { entries } = yield* scanCustom(dir);

        expect(entries.map((entry) => entry.name)).toEqual(['unique']);
      }),
  );

  it.live('reports skipped custom YAML files as scan issues', () =>
    Effect.gen(function* () {
      const dir = yield* agentDir({
        'broken.yaml': ['name: "unterminated'],
        // The nested format has no reader.
        'nested.yaml': [
          'name: nested',
          'settings:',
          '  agentCategory: toolUse',
        ],
        'tools-and-task.yaml': [
          'name: tools-and-task',
          'tools: [read_file]',
          'task:',
          '  requests: [Revise.]',
        ],
        'valid.yaml': toolUseAgent('valid', 'hi'),
      });

      const { entries, issues } = yield* scanCustom(dir);

      expect(entries.map((entry) => entry.name)).toEqual(['valid']);
      expect(issues).toEqual([
        expect.objectContaining({
          path: 'broken.yaml',
          message: expect.stringMatching(/unterminated|Nested mappings|YAML/iu),
        }),
        expect.objectContaining({
          path: 'nested.yaml',
          message: expect.stringContaining('settings'),
        }),
        expect.objectContaining({
          path: 'tools-and-task.yaml',
          message: expect.stringContaining('text-only'),
        }),
      ]);
    }),
  );
});
