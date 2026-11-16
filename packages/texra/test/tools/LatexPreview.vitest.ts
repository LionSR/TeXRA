// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit, FileSystem, Scope, Semaphore } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { previewProposedLatex } from '@texra/controllers/approval/latexPreview';

// Failure mode: a preview's build writes its auxiliary files where the
// host's build puts them (LaTeX Workshop's recommended `outDir` is
// `build/`), and closing the request leaves them behind.
describe('previewProposedLatex', () => {
  it.live('removes the auxiliary files the preview build wrote to build/', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspace = yield* fs.makeTempDirectoryScoped();
      const files = yield* Scope.make();
      const built: string[] = [];
      const errors: string[] = [];

      yield* previewProposedLatex(
        {
          request: {
            path: 'paper.tex',
            roots: createFakeWorkspaceRoots(
              { workspaceRoot: workspace },
              {},
              workspace,
            ),
          },
          originalUri: { fsPath: path.join(workspace, 'paper.tex') },
          proposedUri: { fsPath: path.join(workspace, 'proposed.tex') },
          originalContent: 'a',
          proposedContent: 'b',
          files,
          operation: yield* Semaphore.make(1),
          onError: (message) => errors.push(message),
        },
        {
          openBuildDisplay: (location) =>
            Effect.gen(function* () {
              const buildDir = path.join(workspace, 'build');
              const stem = path.basename(location.absolutePath, '.tex');
              yield* fs.makeDirectory(buildDir, { recursive: true });
              for (const ext of ['.aux', '.log', '.pdf']) {
                const output = path.join(buildDir, stem + ext);
                yield* fs.writeFileString(output, '');
                built.push(output);
              }
            }).pipe(Effect.orDie),
        },
      );
      yield* Scope.close(files, Exit.void);

      expect(errors).toStrictEqual([]);
      expect(built).toHaveLength(3);
      expect(
        yield* fs.readDirectory(path.join(workspace, 'build')),
      ).toStrictEqual([]);
    }).pipe(Effect.provide(nodePlatformLayer)),
  );
});
