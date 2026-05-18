// Standard library imports
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Local imports - agent output
import { publishCompiledPdfArtifact } from '@agent/output/compiledPdfArtifacts';

// Local imports - file utilities
import { createExternalLocation, createRunStorageLocation } from '@utils/files';

describe('compiled PDF artifacts', () => {
  const tempDirs: string[] = [];

  beforeEach(async () => {
    const [{ initPlatform }, { nodeFilesystem }, { createFakePlatform }] =
      await Promise.all([
        import('@platform/platform'),
        import('@platform/defaults/nodeFilesystem'),
        import('@test/support/FakePlatform'),
      ]);
    initPlatform(createFakePlatform({}, { fs: nodeFilesystem }));
  });

  async function makeTempDir(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'texra-pdf-artifact-'));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('publishes per-round and latest stable PDF paths', async () => {
    const runDirectory = await makeTempDir();
    const buildDir = path.join(runDirectory, 'compile', 'build', 'r2', 'paper');
    const compiledPdfPath = path.join(buildDir, 'paper.pdf');
    await mkdir(buildDir, { recursive: true });
    await writeFile(compiledPdfPath, 'pdf bytes');

    const artifact = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'abc123',
      round: 2,
      displayName: 'paper.tex',
      source: createExternalLocation(
        path.join(runDirectory, 'r2', 'paper.tex'),
      ),
      compiledPdfPath,
    });

    expect(artifact?.pdf.relativePath).toBe('output/r2/paper.pdf');
    expect(artifact?.latestPdf.relativePath).toBe('output/latest/paper.pdf');
    await expect(
      readFile(path.join(runDirectory, 'output', 'r2', 'paper.pdf'), 'utf8'),
    ).resolves.toBe('pdf bytes');
    await expect(
      readFile(
        path.join(runDirectory, 'output', 'latest', 'paper.pdf'),
        'utf8',
      ),
    ).resolves.toBe('pdf bytes');
  });

  it('allows callers to publish diff PDFs with canonical names', async () => {
    const runDirectory = await makeTempDir();
    const buildDir = path.join(runDirectory, 'diff', 'r1', 'build');
    const compiledPdfPath = path.join(buildDir, 'output-diff.pdf');
    await mkdir(buildDir, { recursive: true });
    await writeFile(compiledPdfPath, 'diff pdf');

    const artifact = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'def456',
      round: 1,
      displayName: 'chapter-diff.pdf',
      source: createExternalLocation(path.join(runDirectory, 'diff.tex')),
      compiledPdfPath,
      outputPdfName: 'chapter-diff.pdf',
    });

    expect(artifact?.pdf.relativePath).toBe('output/r1/chapter-diff.pdf');
    expect(artifact?.latestPdf.relativePath).toBe(
      'output/latest/chapter-diff.pdf',
    );
  });

  it('derives diff PDF names from the same source path rule', async () => {
    const runDirectory = await makeTempDir();
    const buildDir = path.join(runDirectory, 'diff', 'r4', 'build');
    const compiledPdfPath = path.join(buildDir, 'latexdiff-output.pdf');
    await mkdir(buildDir, { recursive: true });
    await writeFile(compiledPdfPath, 'diff pdf');

    const artifact = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'suffix123',
      round: 4,
      displayName: 'latexdiff-output.tex',
      source: createRunStorageLocation(
        path.join(runDirectory, 'r4', 'sections', 'main.tex'),
        path.join('r4', 'sections', 'main.tex'),
        'suffix123',
      ),
      compiledPdfPath,
      pdfStemSuffix: '-diff',
    });

    expect(artifact?.pdf.relativePath).toBe('output/r4/sections/main-diff.pdf');
    expect(artifact?.latestPdf.relativePath).toBe(
      'output/latest/sections/main-diff.pdf',
    );
  });

  it('keeps distinct diff kinds for the same revised source', async () => {
    const runDirectory = await makeTempDir();
    const buildDir = path.join(runDirectory, 'diff', 'r5', 'build');
    const baseDiffPdfPath = path.join(buildDir, 'base.pdf');
    const roundDiffPdfPath = path.join(buildDir, 'round.pdf');
    const source = createRunStorageLocation(
      path.join(runDirectory, 'r5', 'sections', 'main.tex'),
      path.join('r5', 'sections', 'main.tex'),
      'kind123',
    );
    await mkdir(buildDir, { recursive: true });
    await writeFile(baseDiffPdfPath, 'base diff');
    await writeFile(roundDiffPdfPath, 'round diff');

    const baseDiff = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'kind123',
      round: 5,
      displayName: 'base-diff.tex',
      source,
      compiledPdfPath: baseDiffPdfPath,
      pdfStemSuffix: '-diff',
    });
    const roundDiff = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'kind123',
      round: 5,
      displayName: 'round-diff.tex',
      source,
      compiledPdfPath: roundDiffPdfPath,
      pdfStemSuffix: '-round-diff',
    });

    expect(baseDiff?.pdf.relativePath).toBe('output/r5/sections/main-diff.pdf');
    expect(roundDiff?.pdf.relativePath).toBe(
      'output/r5/sections/main-round-diff.pdf',
    );
    await expect(
      readFile(
        path.join(runDirectory, 'output', 'r5', 'sections', 'main-diff.pdf'),
        'utf8',
      ),
    ).resolves.toBe('base diff');
    await expect(
      readFile(
        path.join(
          runDirectory,
          'output',
          'r5',
          'sections',
          'main-round-diff.pdf',
        ),
        'utf8',
      ),
    ).resolves.toBe('round diff');
  });

  it('preserves source subdirectories for duplicate basenames', async () => {
    const runDirectory = await makeTempDir();
    const buildDir = path.join(runDirectory, 'compile', 'build', 'r3');
    const firstPdfPath = path.join(buildDir, 'ch1-main', 'main.pdf');
    const secondPdfPath = path.join(buildDir, 'ch2-main', 'main.pdf');
    await mkdir(path.dirname(firstPdfPath), { recursive: true });
    await mkdir(path.dirname(secondPdfPath), { recursive: true });
    await writeFile(firstPdfPath, 'chapter 1');
    await writeFile(secondPdfPath, 'chapter 2');

    const first = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'dup123',
      round: 3,
      displayName: 'main.tex',
      source: createRunStorageLocation(
        path.join(runDirectory, 'r3', 'ch1', 'main.tex'),
        path.join('r3', 'ch1', 'main.tex'),
        'dup123',
      ),
      compiledPdfPath: firstPdfPath,
    });
    const second = await publishCompiledPdfArtifact({
      runDirectory,
      executionId: 'dup123',
      round: 3,
      displayName: 'main.tex',
      source: createRunStorageLocation(
        path.join(runDirectory, 'r3', 'ch2', 'main.tex'),
        path.join('r3', 'ch2', 'main.tex'),
        'dup123',
      ),
      compiledPdfPath: secondPdfPath,
    });

    expect(first?.pdf.relativePath).toBe('output/r3/ch1/main.pdf');
    expect(second?.pdf.relativePath).toBe('output/r3/ch2/main.pdf');
    expect(first?.latestPdf.relativePath).toBe('output/latest/ch1/main.pdf');
    expect(second?.latestPdf.relativePath).toBe('output/latest/ch2/main.pdf');
    await expect(
      readFile(
        path.join(runDirectory, 'output', 'r3', 'ch1', 'main.pdf'),
        'utf8',
      ),
    ).resolves.toBe('chapter 1');
    await expect(
      readFile(
        path.join(runDirectory, 'output', 'r3', 'ch2', 'main.pdf'),
        'utf8',
      ),
    ).resolves.toBe('chapter 2');
  });
});
