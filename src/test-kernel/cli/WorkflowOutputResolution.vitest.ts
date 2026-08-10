import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import {
  expectedOutputFilesForOutputDir,
  formatWorkflowTextResult,
  resolveWorkflowOutput,
  type CliWorkflowRunResult,
} from '@cli/runtime/workflowOutput';
import type { CliContext } from '@cli/runtime/cliContext';
import {
  RUN_OUTCOME,
  type RunOutcome,
  AgentCategory,
} from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

type WorkflowResult = Parameters<typeof resolveWorkflowOutput>[2];

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'texra-workflow-output-'));
  tempDirs.push(dir);
  return dir;
}

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
    category: AgentCategory.Workflow,
    outcome,
    executionId: 'workflow-output-test',
    streamId: 'workflow-output-test',
    compileFailures: [],
    outputs: outputs.map((output) => ({
      round: output.round ?? 1,
      relativePath: output.relativePath,
      absolutePath: output.absolutePath,
      location: 'runStorage',
      originalPath: output.originalPath ?? null,
      added: null,
      removed: null,
    })),
  } as WorkflowResult;
}

describe('CLI workflow output resolution', () => {
  it('fails --output-dir resolution when an expected multi-input output is missing', async () => {
    const cwd = await makeTempDir();
    const runOutput = await writeRunFile(cwd, 'r1/a.tex', 'A');

    await expect(
      resolveWorkflowOutput(
        undefined,
        'out',
        workflowResult([{ absolutePath: runOutput, relativePath: 'r1/a.tex' }]),
        testContext(cwd),
        {
          expectedOutputFiles: ['a.tex', 'b.tex'],
          runDirectory: join(cwd, 'run'),
        },
      ),
    ).rejects.toThrow(/b\.tex/);
  });

  it('carries only the cancelled outcome for missing workflow outputs', async () => {
    const cwd = await makeTempDir();

    const result = await resolveWorkflowOutput(
      'out.tex',
      undefined,
      workflowResult([], RUN_OUTCOME.CANCELLED),
      testContext(cwd),
      {},
    );

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.CANCELLED,
      workingDirectory: cwd,
    });
    expect(Object.hasOwn(result, 'status')).toBe(false);
    expect(Object.hasOwn(result, 'terminalStatus')).toBe(false);
    expect(Object.hasOwn(result, 'endGroupStatus')).toBe(false);
    expect(Object.hasOwn(result, 'copiedOutput')).toBe(false);
  });

  it('copies every expected --output-dir workflow output', async () => {
    const cwd = await makeTempDir();
    const runA1 = await writeRunFile(cwd, 'r1/a.tex', 'A1');
    const runA2 = await writeRunFile(cwd, 'r2/a.tex', 'A2');
    const runB = await writeRunFile(cwd, 'r1/b.tex', 'B');

    const result = await resolveWorkflowOutput(
      undefined,
      'out',
      workflowResult([
        { absolutePath: runA1, relativePath: 'r1/a.tex', round: 1 },
        { absolutePath: runB, relativePath: 'r1/b.tex' },
        { absolutePath: runA2, relativePath: 'r2/a.tex', round: 2 },
      ]),
      testContext(cwd),
      {
        expectedOutputFiles: ['a.tex', 'b.tex'],
        runDirectory: join(cwd, 'run'),
      },
    );

    expect(result).toMatchObject({
      outcome: RUN_OUTCOME.COMPLETED,
      workingDirectory: cwd,
      copiedOutputs: [join(cwd, 'out', 'a.tex'), join(cwd, 'out', 'b.tex')],
    });
    await expect(readFile(join(cwd, 'out', 'a.tex'), 'utf8')).resolves.toBe(
      'A2',
    );
    await expect(readFile(join(cwd, 'out', 'b.tex'), 'utf8')).resolves.toBe(
      'B',
    );
  });

  it('uses a stable output name for materialized stdin input', async () => {
    const cwd = await makeTempDir();
    const runOutput = await writeRunFile(cwd, 'r1/stdin.tex', 'from stdin');

    const expectedOutputFiles = expectedOutputFilesForOutputDir(undefined, [
      'texra-stdin-123-abc123/stdin.tex',
    ]);

    expect(expectedOutputFiles).toEqual(['stdin.tex']);

    const result = await resolveWorkflowOutput(
      undefined,
      'out',
      workflowResult([
        {
          absolutePath: runOutput,
          relativePath: 'r1/stdin.tex',
          originalPath: join(
            cwd,
            'run',
            'original',
            'texra-stdin-123-abc123',
            'stdin.tex',
          ),
        },
      ]),
      testContext(cwd),
      {
        expectedOutputFiles,
        runDirectory: join(cwd, 'run'),
      },
    );

    expect(result).toMatchObject({
      copiedOutputs: [join(cwd, 'out', 'stdin.tex')],
    });
    await expect(readFile(join(cwd, 'out', 'stdin.tex'), 'utf8')).resolves.toBe(
      'from stdin',
    );
  });

  it('preserves expected nested input paths when copying flattened workflow outputs', async () => {
    const cwd = await makeTempDir();
    const runMain = await writeRunFile(cwd, 'r1/main.tex', 'main');
    const runSeries = await writeRunFile(cwd, 'r1/series.tex', 'series');

    const result = await resolveWorkflowOutput(
      undefined,
      'out',
      workflowResult([
        {
          absolutePath: runMain,
          relativePath: 'r1/main.tex',
          originalPath: join(cwd, 'run', 'original', 'paper', 'main.tex'),
        },
        {
          absolutePath: runSeries,
          relativePath: 'r1/series.tex',
          originalPath: join(
            cwd,
            'run',
            'original',
            'paper',
            'chapters',
            'series.tex',
          ),
        },
      ]),
      testContext(cwd),
      {
        expectedOutputFiles: ['paper/main.tex', 'paper/chapters/series.tex'],
        runDirectory: join(cwd, 'run'),
      },
    );

    expect(result).toMatchObject({
      copiedOutputs: [
        join(cwd, 'out', 'paper', 'main.tex'),
        join(cwd, 'out', 'paper', 'chapters', 'series.tex'),
      ],
    });
    await expect(
      readFile(join(cwd, 'out', 'paper', 'main.tex'), 'utf8'),
    ).resolves.toBe('main');
    await expect(
      readFile(join(cwd, 'out', 'paper', 'chapters', 'series.tex'), 'utf8'),
    ).resolves.toBe('series');
  });

  it('uses original-path lineage before flat generated names when basenames collide', async () => {
    const cwd = await makeTempDir();
    const runRoot = await writeRunFile(cwd, 'root/main.tex', 'root');
    const runNested = await writeRunFile(cwd, 'nested/main.tex', 'nested');

    const result = await resolveWorkflowOutput(
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
        runDirectory: join(cwd, 'run'),
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

  it('does not remap arbitrary same-source outputs to an expected input name', async () => {
    const cwd = await makeTempDir();
    const runDerived = await writeRunFile(cwd, 'r1/derived.tex', 'derived');

    await expect(
      resolveWorkflowOutput(
        undefined,
        'out',
        workflowResult([
          {
            absolutePath: runDerived,
            relativePath: 'r1/derived.tex',
            originalPath: join(cwd, 'run', 'original', 'paper', 'input.tex'),
          },
        ]),
        testContext(cwd),
        {
          expectedOutputFiles: ['paper/input.tex'],
          runDirectory: join(cwd, 'run'),
        },
      ),
    ).rejects.toThrow(/paper[/\\]input\.tex/);
  });

  it('derives safe expected --output-dir paths from relative and absolute inputs', async () => {
    const external = await makeTempDir();

    expect(
      expectedOutputFilesForOutputDir(undefined, [
        'paper/main.tex',
        'paper/chapters/series.tex',
      ]),
    ).toEqual(['paper/main.tex', 'paper/chapters/series.tex']);
    expect(
      expectedOutputFilesForOutputDir(undefined, [
        join(external, 'paper', 'main.tex'),
        join(external, 'paper', 'chapters', 'series.tex'),
      ]),
    ).toEqual(['main.tex', 'chapters/series.tex']);
  });

  it('does not remap output paths on partial original-path segment matches', async () => {
    const cwd = await makeTempDir();
    const runSeries = await writeRunFile(cwd, 'r1/series.tex', 'series');

    await expect(
      resolveWorkflowOutput(
        undefined,
        'out',
        workflowResult([
          {
            absolutePath: runSeries,
            relativePath: 'r1/series.tex',
            originalPath: join(
              cwd,
              'run',
              'original',
              'mychapters',
              'series.tex',
            ),
          },
        ]),
        testContext(cwd),
        {
          expectedOutputFiles: ['chapters/series.tex'],
          runDirectory: join(cwd, 'run'),
        },
      ),
    ).rejects.toThrow(/chapters[/\\]series\.tex/);
  });

  it('uses the latest round when --output-dir workflow outputs arrive out of order', async () => {
    const cwd = await makeTempDir();
    const runA1 = await writeRunFile(cwd, 'r1/a.tex', 'A1');
    const runA2 = await writeRunFile(cwd, 'r2/a.tex', 'A2');

    await resolveWorkflowOutput(
      undefined,
      'out',
      workflowResult([
        { absolutePath: runA2, relativePath: 'r2/a.tex', round: 2 },
        { absolutePath: runA1, relativePath: 'r1/a.tex', round: 1 },
      ]),
      testContext(cwd),
      {
        expectedOutputFiles: ['a.tex'],
        runDirectory: join(cwd, 'run'),
      },
    );

    await expect(readFile(join(cwd, 'out', 'a.tex'), 'utf8')).resolves.toBe(
      'A2',
    );
  });

  it('uses the latest round when a single requested output arrives out of order', async () => {
    const cwd = await makeTempDir();
    const runA1 = await writeRunFile(cwd, 'r1/a.tex', 'A1');
    const runA2 = await writeRunFile(cwd, 'r2/a.tex', 'A2');

    const result = await resolveWorkflowOutput(
      'out/a.tex',
      undefined,
      workflowResult([
        { absolutePath: runA2, relativePath: 'r2/a.tex', round: 2 },
        { absolutePath: runA1, relativePath: 'r1/a.tex', round: 1 },
      ]),
      testContext(cwd),
      {
        runDirectory: join(cwd, 'run'),
      },
    );

    expect(result).toMatchObject({
      workingDirectory: cwd,
      copiedOutput: join(cwd, 'out', 'a.tex'),
    });
    await expect(readFile(join(cwd, 'out', 'a.tex'), 'utf8')).resolves.toBe(
      'A2',
    );
  });

  it('copies the last output of the final round for a multi-document workflow', async () => {
    const cwd = await makeTempDir();
    const runMain = await writeRunFile(cwd, 'r2/main.tex', 'MAIN2');
    const runAppendix = await writeRunFile(cwd, 'r2/appendix.tex', 'APPENDIX2');
    const runMain1 = await writeRunFile(cwd, 'r1/main.tex', 'MAIN1');

    const result = await resolveWorkflowOutput(
      'out/paper.tex',
      undefined,
      workflowResult([
        { absolutePath: runMain1, relativePath: 'r1/main.tex', round: 1 },
        { absolutePath: runMain, relativePath: 'r2/main.tex', round: 2 },
        {
          absolutePath: runAppendix,
          relativePath: 'r2/appendix.tex',
          round: 2,
        },
      ]),
      testContext(cwd),
      {
        runDirectory: join(cwd, 'run'),
      },
    );

    expect(result).toMatchObject({
      copiedOutput: join(cwd, 'out', 'paper.tex'),
    });
    // Last of the final round: the CLI has always kept the later element on a
    // round tie, so the consolidation onto finalWorkflowOutput preserves it.
    await expect(readFile(join(cwd, 'out', 'paper.tex'), 'utf8')).resolves.toBe(
      'APPENDIX2',
    );
  });

  it('reports the last output of the final round as the text result', () => {
    const result: CliWorkflowRunResult = {
      ...workflowResult([
        { absolutePath: '/run/r1/main.tex', relativePath: 'r1/main.tex' },
        {
          absolutePath: '/run/r2/main.tex',
          relativePath: 'r2/main.tex',
          round: 2,
        },
        {
          absolutePath: '/run/r2/appendix.tex',
          relativePath: 'r2/appendix.tex',
          round: 2,
        },
      ]),
      workingDirectory: '/run',
      runDirectory: '/run',
    };

    expect(formatWorkflowTextResult(result)).toBe('/run/r2/appendix.tex');
  });
});
