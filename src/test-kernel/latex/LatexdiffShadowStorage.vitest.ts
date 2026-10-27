import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

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

  // #13191: a failed diff's message is written verbatim into the run
  // transcript, so latexdiff's stderr is scrubbed where it enters.
  it.effect('scrubs secrets from a failed diff message', () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        makeTempDir('texra-latexdiff-secret-', tempDirs),
      );
      const sourceDir = path.join(tempDir, 'workspace');
      const storageRoot = path.join(tempDir, 'storage');
      yield* Effect.promise(async () => {
        await mkdir(sourceDir, { recursive: true });
        await writeFile(path.join(sourceDir, 'base.tex'), 'old\n');
        await writeFile(path.join(sourceDir, 'revised.tex'), 'new\n');
        await installPlatform(
          {
            workspacePath: sourceDir,
            storagePath: resolveWorkspaceStoragePath(storageRoot, sourceDir),
            globalStoragePath: resolveGlobalStoragePath(storageRoot),
          },
          {
            globalState: new MemoryStateStore(),
            workspaceState: new MemoryStateStore(),
          },
        );
      });
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

      const { LaTeXdiffService } = yield* Effect.promise(
        () => import('@latex/latexdiff'),
      );
      const result = yield* new LaTeXdiffService(
        'test',
        testWorkspaceRoots(),
      ).runDiff(
        createExternalLocation(path.join(sourceDir, 'base.tex')),
        createExternalLocation(path.join(sourceDir, 'revised.tex')),
        '_diff',
        undefined,
        {
          cwd: testWorkspaceRoots().workspace,
          outputDirectory: path.join(tempDir, 'executions', 'run-1', 'diff'),
        },
      );

      expect(result.success).toBe(false);
      expect(result.message).not.toContain('sk-abcdefghijklmnop1234');
      expect(result.message).not.toContain('tok.en-123');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
