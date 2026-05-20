import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/AgentDataclass';
import { END_GROUP_STATUS, EXECUTION_STATUS } from '@shared/schemas';

import { resolveWorkflowOutput } from '../../../packages/cli/src/commands/root';
import type { CliContext } from '../../../packages/cli/src/runtime/cliContext';

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
  return {
    cwd,
    mode: 'headless',
    outputFormat: 'text',
    approvalPolicy: 'never',
    colorEnabled: false,
    version: 'test',
    resourcesPath: cwd,
  };
}

function workflowResult(
  outputs: Array<{ absolutePath: string; relativePath: string }>,
): WorkflowResult {
  return {
    category: AgentCategory.Workflow,
    status: END_GROUP_STATUS.STOPPED,
    executionId: 'workflow-output-test',
    streamId: 'workflow-output-test',
    compileFailures: [],
    outputs: outputs.map((output) => ({
      round: 1,
      relativePath: output.relativePath,
      absolutePath: output.absolutePath,
      location: 'runStorage',
      originalPath: null,
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
          terminalStatus: EXECUTION_STATUS.COMPLETED,
        },
      ),
    ).rejects.toThrow(/b\.tex/);
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

    const { displayResult } = await resolveWorkflowOutput(
      undefined,
      'out',
      workflowResult([
        { absolutePath: runA1, relativePath: 'r1/a.tex' },
        { absolutePath: runB, relativePath: 'r1/b.tex' },
        { absolutePath: runA2, relativePath: 'r2/a.tex' },
      ]),
      testContext(cwd),
      {
        expectedOutputFiles: ['a.tex', 'b.tex'],
        runDirectory: join(cwd, 'run'),
        terminalStatus: EXECUTION_STATUS.COMPLETED,
      },
    );

    expect(displayResult).toMatchObject({
      copiedOutputs: [join(cwd, 'out', 'a.tex'), join(cwd, 'out', 'b.tex')],
    });
    await expect(readFile(join(cwd, 'out', 'a.tex'), 'utf8')).resolves.toBe(
      'A2',
    );
    await expect(readFile(join(cwd, 'out', 'b.tex'), 'utf8')).resolves.toBe(
      'B',
    );
  });
});
