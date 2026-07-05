// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - agent
import { installPlatform } from '@test/support/setupPlatform';
import type { AgentTrace } from '@agent/trace';
import {
  AgentCategory,
  AgentWorkflowSettingSchema,
} from '@agent/core/definition/AgentDataclass';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';
import { runCompileCheck } from '@agent/output/compileCheck';
import { createOutputState, ensureRoundData } from '@agent/output/outputState';

// Local imports - shared
import type {
  ExecutionId,
  FileLocation,
  OutputFileInfo,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - file utilities
import {
  TaskRunFileService,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files';

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(async () => true),
  hasLatexCompiler: vi.fn(async () => true),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

const storagePath = '/storage';
const workspacePath = '/workspace';

function runDir(executionId: ExecutionId): string {
  return path.join(storagePath, 'executions', executionId);
}

function runStorageFile(
  executionId: ExecutionId,
  relativePath: string,
): FileLocation {
  return createRunStorageLocation(
    path.join(runDir(executionId), relativePath),
    relativePath,
    executionId,
  );
}

function outputFile(
  executionId: ExecutionId,
  relativePath: string,
  source: string,
  round: number,
): OutputFileInfo {
  return {
    source,
    round,
    location: runStorageFile(executionId, relativePath),
    lineage: null,
    diff: null,
  };
}

function logger(): AgentTrace {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AgentTrace;
}

function initLatexPlatform(files: Record<string, string>): Promise<void> {
  return installPlatform({
    files,
    storagePath,
    workspacePath,
    workspaceState: {
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE]: true,
      [WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS]: 30_000,
    },
  });
}

describe('workflow LaTeX compile input directories', () => {
  beforeEach(() => {
    mocks.compileLatex2Pdf.mockClear();
    mocks.hasLatexCompiler.mockClear();
  });

  it('derives compile-check input dirs from outputFile.source', async () => {
    const executionId = 'compile-source-dir';
    const texPath = path.join(runDir(executionId), 'r1', 'main.tex');
    await initLatexPlatform({
      [texPath]: '\\documentclass{article}\\begin{document}Hi\\end{document}',
    });

    const outputState = createOutputState();
    ensureRoundData(outputState, 1).outputs = [
      outputFile(executionId, path.join('r1', 'main.tex'), 'Draft/main.tex', 1),
    ];

    await runCompileCheck(
      {
        fileService: new TaskRunFileService(executionId),
        outputState,
        logger: logger(),
        streamId: 'compile-stream',
      },
      1,
    );

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: texPath }),
      expect.objectContaining({
        extraInputDirs: [path.join(workspacePath, 'Draft')],
      }),
    );
  });

  it('compiles diffs with revised round inputs before workspace fallbacks', async () => {
    const executionId = 'latexdiff-input-dir';
    await initLatexPlatform({});

    const manager = new LatexDiffManager(
      AgentWorkflowSettingSchema.parse({
        agentCategory: AgentCategory.Workflow,
      }),
      () => ({}),
      [],
      logger(),
      'diff-stream',
      new TaskRunFileService(executionId),
    );

    const referenceLocation = createWorkspaceLocation(
      path.join(workspacePath, 'Draft', 'main.tex'),
      'Draft/main.tex',
    );
    const sourceLocation = runStorageFile(
      executionId,
      path.join('r2', 'Draft', 'main.tex'),
    );
    const compileDiff = manager as unknown as {
      compileDiffIfSuccessful(
        result: { success: boolean; diffFileName?: string },
        referenceLocation: FileLocation,
        diffDirectory: {
          absolutePath: string;
          relativePath: string;
          executionId: ExecutionId;
        },
        round: number,
        sourceLocation: FileLocation,
        pdfStemSuffix: string,
      ): Promise<unknown>;
    };

    await compileDiff.compileDiffIfSuccessful(
      { success: true, diffFileName: 'main-diff.tex' },
      referenceLocation,
      {
        absolutePath: path.join(runDir(executionId), 'diff', 'r2'),
        relativePath: path.join('diff', 'r2'),
        executionId,
      },
      2,
      sourceLocation,
      '-diff',
    );

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledWith(
      expect.objectContaining({
        absolutePath: path.join(
          runDir(executionId),
          'diff',
          'r2',
          'main-diff.tex',
        ),
      }),
      expect.objectContaining({
        extraInputDirs: [
          path.join(runDir(executionId), 'r2', 'Draft'),
          path.join(workspacePath, 'Draft'),
        ],
      }),
    );
  });
});
