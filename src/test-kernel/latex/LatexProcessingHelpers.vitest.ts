import { lstat, mkdir, readlink, realpath, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { Context, Effect, Layer } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import { RunFileService } from '@texra-ai/harness/plugins';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@texra-ai/harness/node';
import {
  createWorkspaceLocation,
  sessionFsLayer,
} from '@texra-ai/harness/host';
import { runDirUnder } from '@common/storage/storageLayout';
import { LatexMediaManager } from '@latex/LatexMediaManager';
import type { FakePlatformOptions } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { spiedTrace } from '@test/support/spiedTrace';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost } from '@test/support/testKernel';
import type { DocumentTaskOptions } from '@texra/shared/plugins/documents';
import type { RunId } from '@texra-ai/harness/schemas';

const logger = spiedTrace();

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
    host: FakePlatformOptions;
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
    return {
      texPath,
      figurePath,
      host: {
        workspacePath: workspaceDir,
        storagePath: resolveWorkspaceStoragePath(storageRoot, workspaceDir),
        globalStoragePath: resolveGlobalStoragePath(storageRoot),
      },
    };
  }

  /** Resolve the symlink `mirrorWorkspaceFile` creates in run storage under
   * `storage` and assert it points back at the real workspace figure. */
  async function expectFigureMirrored(
    storage: string,
    runId: RunId,
    figurePath: string,
  ): Promise<void> {
    const mirroredPath = path.join(
      runDirUnder(storage, runId),
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
      // cast: a fixture run id; the run's file service only names a directory with it.
      const runId = 'extract-figure' as RunId;
      const { texPath, figurePath, host } = yield* Effect.promise(writeFixture);
      const { roots } = Context.get(
        yield* Layer.build(FakeHost.layer(host)),
        FakeHost,
      );
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
      yield* Effect.promise(() =>
        expectFigureMirrored(roots.storage, runId, figurePath),
      );
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
