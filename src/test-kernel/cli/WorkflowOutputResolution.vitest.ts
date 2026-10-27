import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import { resolveWorkflowOutput } from '@cli/runtime/workflowOutput';
import type { CliContext } from '@cli/runtime/cliContext';
import { RUN_OUTCOME, type RunId, type RunOutcome } from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { runDirUnder } from '@utils/files/runStorageFs';

type WorkflowResult = Parameters<typeof resolveWorkflowOutput>[2];

/** `resolveWorkflowOutput`, run at this suite's one Effect boundary. */
const resolveOutput = (...args: Parameters<typeof resolveWorkflowOutput>) =>
  Effect.runPromise(
    resolveWorkflowOutput(...args).pipe(Effect.provide(nodePlatformLayer)),
  );

const tempDirs = useTempDirs();

const TEST_RUN_ID = 'workflow-output-test' as RunId;

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

function testContext(cwd: string): CliContext {
  return createTestCliContext({
    cwd,
    version: 'test',
    resourcesPath: cwd,
  });
}

function workflowResult(
  outputs: Array<{
    absolutePath: string;
    relativePath: string;
    originalPath?: string | null;
    round?: number;
  }>,
  outcome: RunOutcome = RUN_OUTCOME.COMPLETED,
): WorkflowResult {
  return {
    outcome,
    output: {
      response: '',
      files: [],
      // A document task's recipe returns its documents.
      structured: {
        compileFailures: [],
        diffs: [],
        outputs: outputs.map((output) => ({
          round: output.round ?? 1,
          relativePath: output.relativePath,
          absolutePath: output.absolutePath,
          location: 'runStorage',
          originalPath: output.originalPath ?? null,
          added: null,
          removed: null,
        })),
      },
    },
    runId: TEST_RUN_ID,
  };
}

describe('CLI workflow output resolution', () => {
  it('does not publish cancelled workflow outputs to requested destinations', async () => {
    const cwd = await makeTempDir('texra-workflow-output-', tempDirs);
    const runOutput = await writeRunFile(cwd, 'r0/paper.tex', 'provisional');
    const outputFile = join(cwd, 'out.tex');
    await writeFile(outputFile, 'existing file');

    const result = await resolveOutput(
      outputFile,
      undefined,
      workflowResult(
        [{ absolutePath: runOutput, relativePath: 'r0/paper.tex', round: 0 }],
        RUN_OUTCOME.CANCELLED,
      ),
      testContext(cwd),
      { storageRoot: join(cwd, 'storage') },
    );

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.CANCELLED,
      runDirectory: runDirUnder(join(cwd, 'storage'), TEST_RUN_ID),
    });
    expect(Object.hasOwn(result, 'copiedOutput')).toBe(false);
    await expect(readFile(outputFile, 'utf8')).resolves.toBe('existing file');
  });

  it('uses original-path lineage before flat generated names when basenames collide', async () => {
    const cwd = await makeTempDir('texra-workflow-output-', tempDirs);
    const runRoot = await writeRunFile(cwd, 'root/main.tex', 'root');
    const runNested = await writeRunFile(cwd, 'nested/main.tex', 'nested');

    const result = await resolveOutput(
      undefined,
      'out',
      workflowResult([
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
      testContext(cwd),
      {
        expectedOutputFiles: ['paper/main.tex', 'paper/chapters/main.tex'],
        storageRoot: join(cwd, 'storage'),
      },
    );

    expect(result).toMatchObject({
      copiedOutputs: [
        join(cwd, 'out', 'paper', 'main.tex'),
        join(cwd, 'out', 'paper', 'chapters', 'main.tex'),
      ],
    });
    await expect(
      readFile(join(cwd, 'out', 'paper', 'main.tex'), 'utf8'),
    ).resolves.toBe('root');
    await expect(
      readFile(join(cwd, 'out', 'paper', 'chapters', 'main.tex'), 'utf8'),
    ).resolves.toBe('nested');
  });
});
