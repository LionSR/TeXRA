import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { MemoryStateStore } from '@platform/defaults/memoryState';
import {
  resolveGlobalStoragePath,
  resolveWorkspaceStoragePath,
} from '@platform/defaults/workspaceStorage';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installPlatform } from '@test/support/setupPlatform';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { createExternalLocation } from '@utils/files/fileLocation';

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
}));

vi.mock('@utils/system/execUtils', () => ({
  executeCommand: mocks.executeCommand,
}));

describe('LaTeXdiffService shadow output', () => {
  const tempDirs = useTempDirs();

  function installNodeBackedPlatform(
    workspaceDir: string,
    storageRoot: string,
  ): Promise<void> {
    return installPlatform(
      {
        workspacePath: workspaceDir,
        storagePath: resolveWorkspaceStoragePath(storageRoot, workspaceDir),
        globalStoragePath: resolveGlobalStoragePath(storageRoot),
      },
      {
        globalState: new MemoryStateStore(),
        workspaceState: new MemoryStateStore(),
      },
    );
  }

  // Shared setup for the two runDiff tests: write base/revised sources into a
  // fresh workspace, install the node-backed platform, and return the source
  // and shadow output directories.
  async function prepareDiffWorkspace(
    prefix: string,
    baseContent: string,
    revisedContent: string,
  ): Promise<{ sourceDir: string; shadowDir: string }> {
    const tempDir = await makeTempDir(prefix, tempDirs);
    const sourceDir = path.join(tempDir, 'workspace');
    const shadowDir = path.join(tempDir, 'executions', 'run-1', 'diff', 'r1');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, 'base.tex'), baseContent);
    await writeFile(path.join(sourceDir, 'revised.tex'), revisedContent);
    await installNodeBackedPlatform(sourceDir, path.join(tempDir, 'storage'));
    return { sourceDir, shadowDir };
  }

  const runShadowDiff = Effect.fn('runShadowDiff')(function* (
    sourceDir: string,
    shadowDir: string,
  ) {
    const { LaTeXdiffService } = yield* Effect.promise(
      () => import('@latex/latexdiff'),
    );
    return yield* new LaTeXdiffService('test', testWorkspaceRoots()).runDiff(
      createExternalLocation(path.join(sourceDir, 'base.tex')),
      createExternalLocation(path.join(sourceDir, 'revised.tex')),
      '_diff',
      undefined,
      { cwd: testWorkspaceRoots().workspace, outputDirectory: shadowDir },
    );
  });

  beforeEach(() => {
    mocks.executeCommand.mockReturnValue(
      Effect.succeed({
        success: true,
        stdout:
          '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n',
        stderr: '',
      }),
    );
  });

  afterEach(async () => {
    vi.clearAllMocks();
  });

  // #13191: a failed diff's message is written verbatim into the run
  // transcript, so latexdiff's stderr is scrubbed where it enters.
  it.effect('scrubs secrets from a failed diff message', () =>
    Effect.gen(function* () {
      const { sourceDir, shadowDir } = yield* Effect.promise(() =>
        prepareDiffWorkspace(
          'texra-latexdiff-secret-',
          '\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n',
          '\\documentclass{article}\n\\begin{document}\nnew\n\\end{document}\n',
        ),
      );
      mocks.executeCommand.mockReturnValueOnce(
        Effect.succeed({
          success: false,
          stdout: '',
          stderr:
            'OPENAI_API_KEY=sk-abcdefghijklmnop1234 Authorization: Bearer tok.en-123',
          timedOut: false,
          exitCode: 1,
        }),
      );

      const result = yield* runShadowDiff(sourceDir, shadowDir);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Failed to run');
      expect(result.message).not.toContain('sk-abcdefghijklmnop1234');
      expect(result.message).not.toContain('tok.en-123');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
