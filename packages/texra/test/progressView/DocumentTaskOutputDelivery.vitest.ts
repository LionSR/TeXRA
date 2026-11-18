import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { deliverDocumentTaskOutputs } from '@texra/controllers/progressView/documentTaskOutputs';
import type { OutputFileSummary } from '@texra/shared/plugins/documentOutputs';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

/** `deliverDocumentTaskOutputs`, run at this suite's one Effect boundary. */
const deliver = (...args: Parameters<typeof deliverDocumentTaskOutputs>) =>
  Effect.runPromise(
    deliverDocumentTaskOutputs(...args).pipe(Effect.provide(nodePlatformLayer)),
  );

const tempDirs = useTempDirs();

/** Writes a generated file under `<cwd>/run/` and returns its absolute path. */
async function writeRunFile(
  cwd: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const absolutePath = join(cwd, 'run', ...relativePath.split('/'));
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
  return absolutePath;
}

/** The outputs a task's documents row reports. */
function reportedOutputs(
  outputs: Array<{
    absolutePath: string;
    relativePath: string;
    originalPath?: string | null;
    round?: number;
  }>,
): OutputFileSummary[] {
  return outputs.map((output) => ({
    round: output.round ?? 1,
    relativePath: output.relativePath,
    absolutePath: output.absolutePath,
    location: 'runStorage',
    originalPath: output.originalPath ?? null,
    added: null,
    removed: null,
  }));
}

describe('document task output delivery', () => {
  it('uses original-path lineage before flat generated names when basenames collide', async () => {
    const cwd = await makeTempDir('texra-workflow-output-', tempDirs);
    const runRoot = await writeRunFile(cwd, 'root/main.tex', 'root');
    const runNested = await writeRunFile(cwd, 'nested/main.tex', 'nested');

    const copied = await deliver(
      reportedOutputs([
        {
          absolutePath: runRoot,
          relativePath: 'r1/main.tex',
          originalPath: join(cwd, 'run', 'original', 'paper', 'main.tex'),
        },
        {
          absolutePath: runNested,
          relativePath: 'r1/main.tex',
          originalPath: join(
            cwd,
            'run',
            'original',
            'paper',
            'chapters',
            'main.tex',
          ),
        },
      ]),
      {
        kind: 'directory',
        path: 'out',
        expected: ['paper/main.tex', 'paper/chapters/main.tex'],
      },
      cwd,
    );

    expect(copied).toEqual([
      join(cwd, 'out', 'paper', 'main.tex'),
      join(cwd, 'out', 'paper', 'chapters', 'main.tex'),
    ]);
    await expect(
      readFile(join(cwd, 'out', 'paper', 'main.tex'), 'utf8'),
    ).resolves.toBe('root');
    await expect(
      readFile(join(cwd, 'out', 'paper', 'chapters', 'main.tex'), 'utf8'),
    ).resolves.toBe('nested');
  });
});
