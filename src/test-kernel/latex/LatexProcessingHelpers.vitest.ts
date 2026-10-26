import { lstat, mkdir, readlink, realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Effect } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { LatexMediaManager, type LatexTrace } from '@latex/LatexMediaManager';
import { sessionFsLayer } from '@platform/rootedFs';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import type { RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import type { DocumentTaskOptions } from '@texra/shared/plugins/documents';
import { createWorkspaceLocation } from '@utils/files/fileLocation';
import { runDirUnder } from '@utils/files/runStorageFs';
import { RunFileService } from '@utils/files/runStorage';

const logger: LatexTrace = spiedTrace();

const extractFiguresConfig: DocumentTaskOptions = {
  autoExtractFigure: true,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  autoCompileInputPdf: false,
  reflect: false,
};

const tempDirs = useTempDirs();

describe('LatexMediaManager figure extraction', () => {
  async function writeFixture(): Promise<{
    texPath: string;
    figurePath: string;
  }> {
    const tempDir = await makeTempDir('texra-latex-media-', tempDirs);
    const workspaceDir = path.join(tempDir, 'workspace');
    const storageRoot = path.join(tempDir, 'storage');
    const figureDir = path.join(workspaceDir, 'figures');
    const texPath = path.join(workspaceDir, 'main.tex');
    const figurePath = path.join(figureDir, 'plot.png');

    await mkdir(figureDir, { recursive: true });
    await writeFile(
      texPath,
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\includegraphics{figures/plot.png}',
        '\\end{document}',
        '',
      ].join('\n'),
    );
    await writeFile(figurePath, 'fake-png-bytes');
    await installPlatform({
      workspacePath: workspaceDir,
      storagePath: resolveWorkspaceStoragePath(storageRoot, workspaceDir),
      globalStoragePath: resolveGlobalStoragePath(storageRoot),
    });
    return { texPath, figurePath };
  }

  /** Resolve the symlink `mirrorWorkspaceFile` creates in run storage and
   * assert it points back at the real workspace figure. */
  async function expectFigureMirrored(
    runId: RunId,
    figurePath: string,
  ): Promise<void> {
    const mirroredPath = path.join(
      runDirUnder(testWorkspaceRoots().storage, runId),
      'figures/plot.png',
    );
    const stats = await lstat(mirroredPath);
    expect(stats.isSymbolicLink()).toBe(true);
    const target = await readlink(mirroredPath);
    expect(
      await realpath(path.resolve(path.dirname(mirroredPath), target)),
    ).toBe(await realpath(figurePath));
  }

  it.effect('processInputFiles records and mirrors an included figure', () =>
    Effect.gen(function* () {
      const runId = 'extract-figure' as RunId;
      const { texPath, figurePath } = yield* Effect.promise(writeFixture);

      const roots = testWorkspaceRoots();
      const manager = new LatexMediaManager(
        logger,
        roots,
        new RunFileService(runId, roots),
      );
      const media = yield* manager
        .processInputFiles(
          [createWorkspaceLocation(texPath, 'main.tex')],
          extractFiguresConfig,
        )
        .pipe(Effect.provide(sessionFsLayer(roots)));

      expect(media.map((f) => f.absolutePath)).toEqual([figurePath]);
      yield* Effect.promise(() => expectFigureMirrored(runId, figurePath));
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
