import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import {
  expectedOutputFilesForOutputDir,
  resolveWorkflowOutput,
} from '@cli/runtime/workflowOutput';
import type { CliContext } from '@cli/runtime/cliContext';
import { RUN_OUTCOME, type RunOutcome } from '@shared/schemas';

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
    const runOutput = join(cwd, 'run', 'r1', 'a.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await writeFile(runOutput, 'A');

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
    const runA1 = join(cwd, 'run', 'r1', 'a.tex');
    const runA2 = join(cwd, 'run', 'r2', 'a.tex');
    const runB = join(cwd, 'run', 'r1', 'b.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await mkdir(join(cwd, 'run', 'r2'), { recursive: true });
    await writeFile(runA1, 'A1');
    await writeFile(runA2, 'A2');
    await writeFile(runB, 'B');

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
    const runOutput = join(cwd, 'run', 'r1', 'stdin.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await writeFile(runOutput, 'from stdin');

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
    const runMain = join(cwd, 'run', 'r1', 'main.tex');
    const runSeries = join(cwd, 'run', 'r1', 'series.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await writeFile(runMain, 'main');
    await writeFile(runSeries, 'series');

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
    const runRoot = join(cwd, 'run', 'root', 'main.tex');
    const runNested = join(cwd, 'run', 'nested', 'main.tex');
    await mkdir(join(cwd, 'run', 'root'), { recursive: true });
    await mkdir(join(cwd, 'run', 'nested'), { recursive: true });
    await writeFile(runRoot, 'root');
    await writeFile(runNested, 'nested');

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
    const runDerived = join(cwd, 'run', 'r1', 'derived.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await writeFile(runDerived, 'derived');

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
    ).toEqual(['main.tex', join('chapters', 'series.tex')]);
  });

  it('does not remap output paths on partial original-path segment matches', async () => {
    const cwd = await makeTempDir();
    const runSeries = join(cwd, 'run', 'r1', 'series.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await writeFile(runSeries, 'series');

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
    const runA1 = join(cwd, 'run', 'r1', 'a.tex');
    const runA2 = join(cwd, 'run', 'r2', 'a.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await mkdir(join(cwd, 'run', 'r2'), { recursive: true });
    await writeFile(runA1, 'A1');
    await writeFile(runA2, 'A2');

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
    const runA1 = join(cwd, 'run', 'r1', 'a.tex');
    const runA2 = join(cwd, 'run', 'r2', 'a.tex');
    await mkdir(join(cwd, 'run', 'r1'), { recursive: true });
    await mkdir(join(cwd, 'run', 'r2'), { recursive: true });
    await writeFile(runA1, 'A1');
    await writeFile(runA2, 'A2');

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
});
