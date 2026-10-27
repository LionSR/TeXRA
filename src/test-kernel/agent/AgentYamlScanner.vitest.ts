// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { beforeAll, describe, expect } from 'vitest';

// Local imports
import { scanDirectory } from '@agent/index/agentYamlScanner';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import {
  installPlatform,
  storePluginsLayer,
} from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempDirs = useTempDirs();

describe('agent YAML scanner', () => {
  beforeAll(() => installPlatform({}));

  // A file the scan skips must surface as an issue: a custom agent that
  // silently vanishes from the list is a bug nobody reports.
  it.live('reports skipped custom YAML files as scan issues', () =>
    Effect.gen(function* () {
      const files: Record<string, readonly string[]> = {
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
        'valid.yaml': ['name: valid', 'prompt: hi'],
      };
      const dir = yield* Effect.promise(async () => {
        const agentDir = await makeTempDir('texra-agent-scan-', tempDirs);
        for (const [fileName, lines] of Object.entries(files)) {
          await writeFile(resolve(agentDir, fileName), `${lines.join('\n')}\n`);
        }
        return agentDir;
      });

      const { entries, issues } = yield* scanDirectory([dir], 'custom').pipe(
        Effect.provide(Layer.merge(nodePlatformLayer, storePluginsLayer)),
      );

      expect(entries.map((entry) => entry.name)).toEqual(['valid']);
      expect(issues.map((issue) => issue.path)).toEqual([
        'broken.yaml',
        'nested.yaml',
        'tools-and-task.yaml',
      ]);
    }),
  );
});
