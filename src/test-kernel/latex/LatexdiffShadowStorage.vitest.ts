import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Context, Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { createExternalLocation } from '@texra-ai/harness/plugins';
import { latexdiff } from '@latex/latexdiff';
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { FakeHost } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';

describe('latexdiff shadow output', () => {
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
        await writeFile(
          path.join(sourceDir, 'base.tex'),
          '\\documentclass{article}\n\\begin{document}\nold\n\\end{document}\n',
        );
        await writeFile(
          path.join(sourceDir, 'revised.tex'),
          '\\documentclass{article}\n\\begin{document}\nnew\n\\end{document}\n',
        );
      });
      const { roots } = Context.get(
        yield* Layer.build(
          FakeHost.layer(
            {
              app: TEXRA_APP,
              workspaceRoot: sourceDir,
              storageRoot,
            },
            {
              globalState: new MemoryStateStore(),
              workspaceState: new MemoryStateStore(),
            },
          ),
        ),
        FakeHost,
      );
      const tool = scriptedSpawnerLayer(() => ({
        stderr:
          'OPENAI_API_KEY=sk-abcdefghijklmnop1234 Authorization: Bearer tok.en-123',
        exitCode: 1,
      }));

      const error = yield* Effect.flip(
        latexdiff(
          createExternalLocation(path.join(sourceDir, 'base.tex')),
          createExternalLocation(path.join(sourceDir, 'revised.tex')),
          {
            roots,
            cwd: roots.workspace,
            suffix: '_diff',
            outputDirectory: path.join(tempDir, 'executions', 'run-1', 'diff'),
          },
        ).pipe(Effect.provide(tool.layer)),
      );

      // The failure must come from the scrubbed subprocess path, not an
      // earlier input guard.
      expect(error.message).toContain('Failed to run');
      expect(error.message).not.toContain('sk-abcdefghijklmnop1234');
      expect(error.message).not.toContain('tok.en-123');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
