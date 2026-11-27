import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Context, Effect, Layer, Scope, Semaphore } from 'effect';
import { describe, expect } from 'vitest';

import { Settings } from '@texra-ai/worldline/plugins';
import { latexdiff } from '@latex/latexdiff';
import { runLatexdiff } from '@texra/controllers/approval/latexPreview';
import {
  LATEXDIFF_CHANGES_ONLY_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
} from '@texra/shared/settings/latexdiffSettings';
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
          { kind: 'external', absolutePath: path.join(sourceDir, 'base.tex') },
          {
            kind: 'external',
            absolutePath: path.join(sourceDir, 'revised.tex'),
          },
          {
            roots,
            cwd: roots.workspace,
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

  // The approval preview passed its own math markup and change marking,
  // so the two settings the LaTeX page shows for it changed nothing.
  it.effect("marks up an edit's preview as the workspace settings say", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        makeTempDir('texra-latexdiff-settings-', tempDirs),
      );
      const sourceDir = path.join(tempDir, 'workspace');
      yield* Effect.promise(() => mkdir(sourceDir, { recursive: true }));
      const { roots } = Context.get(
        yield* Layer.build(
          FakeHost.layer(
            {
              app: TEXRA_APP,
              workspaceRoot: sourceDir,
              storageRoot: path.join(tempDir, 'storage'),
            },
            {
              globalState: new MemoryStateStore(),
              workspaceState: new MemoryStateStore(),
            },
          ),
        ),
        FakeHost,
      );
      yield* Settings.set(roots, LATEXDIFF_MATH_MARKUP_SETTING, 'fine');
      yield* Settings.set(roots, LATEXDIFF_CHANGES_ONLY_SETTING, false);
      const tool = scriptedSpawnerLayer(() => ({ exitCode: 1 }));
      const document = (body: string) =>
        `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;

      yield* runLatexdiff(
        {
          request: { path: path.join(sourceDir, 'main.tex'), roots },
          preview: {
            originalPath: path.join(tempDir, 'absent-original.tex'),
            proposedPath: path.join(tempDir, 'absent-proposed.tex'),
          },
          originalContent: document('old'),
          proposedContent: document('new'),
          files: yield* Scope.Scope,
          operation: yield* Semaphore.make(1),
          onError: () => Effect.void,
        },
        { openBuildDisplay: () => Effect.void },
      ).pipe(Effect.provide(tool.layer));

      const diffArgs = tool.calls
        .map((call) => call.args)
        .find((args) => args.includes('--encoding=utf8'));
      expect(diffArgs).toContain('--math-markup=fine');
      expect(diffArgs?.join(' ')).not.toContain('--subtype=');
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
