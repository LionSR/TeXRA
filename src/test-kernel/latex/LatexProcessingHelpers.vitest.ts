// Standard library imports
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';

// Local imports - test support
import { installPlatform as installFakePlatform } from '@test/support/setupPlatform';

// Local imports - agent
import type { AgentTrace } from '@agent/trace';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';

// Local imports - latex
import { LatexMediaManager } from '@latex/LatexMediaManager';
import { DiffFileProcessor } from '@latex/latexdiff/diffFileProcessor';
import type { FileLocation } from '@shared/schemas';
import type { ToolConfig } from '@shared/schemas/toolConfig';
import { createExternalLocation } from '@utils/files';

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(),
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

type DiffFileProcessorInternals = {
  processLineByLine(content: string): string;
};

const compilePdfConfig: ToolConfig = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  autoCompileInputPdf: true,
};

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as AgentTrace;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-latex-media-'));
  tempDirs.push(tempDir);
  return tempDir;
}

function installPlatform(workspaceDir: string): Promise<void> {
  return installFakePlatform(
    { workspacePath: workspaceDir },
    { fs: nodeFilesystem },
  );
}

function processLineByLine(content: string): string {
  return (
    new DiffFileProcessor() as unknown as DiffFileProcessorInternals
  ).processLineByLine(content);
}

describe('DiffFileProcessor line formatting', () => {
  it('preserves package blank-line insertion order', () => {
    const processed = processLineByLine(
      [
        '% !TEX root = main.tex',
        'Here is preamble text from latexdiff',
        '\\documentclass{article}',
        '\\usepackage{tikz}',
        '\\usepackage{pgfplots}',
        '\\providecommand{\\DIFaddbegin}{}',
        '\\RequirePackage[normalem]{ulem}',
        '\\usetikzlibrary{calc}',
        '\\RequirePackage{color}',
        'body',
      ].join('\n'),
    );

    expect(processed).toBe(
      [
        '\\documentclass{article}',
        '',
        '\\usepackage{tikz}',
        '',
        '\\usepackage{pgfplots}',
        '',
        '\\providecommand{\\DIFaddbegin}{}',
        '',
        '\\RequirePackage[normalem]{ulem}',
        '',
        '\\usetikzlibrary{calc}',
        '',
        '\\RequirePackage{color}',
        '',
        'body',
        '',
      ].join('\n'),
    );
  });
});

describe('LatexMediaManager PDF compilation', () => {
  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('filters nullish compile results before adding media files', async () => {
    const workspaceDir = await makeTempDir();
    await installPlatform(workspaceDir);

    const inputPaths = [
      path.join(workspaceDir, 'compiled.tex'),
      path.join(workspaceDir, 'missing-result.tex'),
    ];
    await Promise.all(
      inputPaths.map(async (filePath) => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, '\\documentclass{article}\n');
      }),
    );

    const compiledPdfPath = path.join(workspaceDir, 'build', 'compiled.pdf');
    mocks.compileLatex2Pdf.mockImplementation(
      async (file: FileLocation, options: { outputDirectory?: string }) => {
        if (path.basename(file.absolutePath) === 'missing-result.tex') {
          return undefined;
        }
        const outputDirectory = options.outputDirectory!;
        await mkdir(outputDirectory, { recursive: true });
        await writeFile(compiledPdfPath, 'compiled pdf');
        return true;
      },
    );

    const workspaceState = AgentWorkspaceState.create();
    const manager = new LatexMediaManager(logger);
    await manager.processInputFiles(
      inputPaths.map(createExternalLocation),
      workspaceState,
      compilePdfConfig,
      true,
    );

    expect(mocks.compileLatex2Pdf).toHaveBeenCalledTimes(2);
    expect(workspaceState.media.files.map((file) => file.absolutePath)).toEqual(
      [compiledPdfPath],
    );
  });
});
