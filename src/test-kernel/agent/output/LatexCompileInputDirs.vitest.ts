// Node imports
import * as path from 'node:path';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { fileLocationDisplayPath, type RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { installPlatform } from '@test/support/setupPlatform';
import { spiedTrace } from '@test/support/spiedTrace';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import { DocumentsStateKey } from '@texra/shared/settingsView/documentsSettings';
import { LatexDiffManager } from '@texra/agent/output/LatexDiffManager';
import { RunFileService } from '@utils/files/runStorage';

// Local file imports
import {
  compileFsLayer,
  runDir,
  runStorageFile,
  storagePath,
  workspacePath,
} from './compileCheckTestUtils';

const mocks = vi.hoisted(() => ({
  compileLatex2Pdf: vi.fn(
    (): Effect.Effect<{ ok: boolean; logTail?: string }> =>
      Effect.succeed({ ok: true }),
  ),
  hasLatexCompiler: vi.fn((): Effect.Effect<boolean> => Effect.succeed(true)),
  publishCompiledPdfArtifact: vi.fn((): Effect.Effect<null, Error> =>
    Effect.succeed(null),
  ),
  // The latexdiff process edge: its probe and its run.
  checkToolInstalled: vi.fn((): Effect.Effect<boolean> => Effect.succeed(true)),
  executeCommand: vi.fn(() =>
    Effect.succeed({
      success: true,
      stdout:
        '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n',
      stderr: '',
    }),
  ),
}));

vi.mock('@texra/utils/system/toolChecks', () => ({
  checkToolInstalled: mocks.checkToolInstalled,
}));

vi.mock('@utils/system/execUtils', () => ({
  executeCommand: mocks.executeCommand,
}));

vi.mock('@latex/texTools', () => ({
  compileLatex2Pdf: mocks.compileLatex2Pdf,
}));

vi.mock('@latex/latexToolchain', () => ({
  hasLatexCompiler: mocks.hasLatexCompiler,
}));

vi.mock('@texra/agent/output/compiledPdfArtifacts', async (importOriginal) => ({
  // Only the publish is mocked: no PDF is ever written here.
  ...(await importOriginal<
    typeof import('@texra/agent/output/compiledPdfArtifacts')
  >()),
  publishCompiledPdfArtifact: mocks.publishCompiledPdfArtifact,
}));

describe('workflow LaTeX compile input directories', () => {
  // Two documents sharing a file name: each pair's diff once landed on the
  // same flat `diff/r1/main_diff.tex`, the second overwriting the first.
  it.live("writes each document's latexdiffs under its own folder", () =>
    Effect.gen(function* () {
      const runId = 'latexdiff-same-basename' as RunId;
      const document = (body: string) =>
        `\\documentclass{article}\\begin{document}${body}\\end{document}`;
      const files = ['original', 'r0', 'r1'].flatMap((dir) =>
        ['a', 'b'].map((folder) => path.join(dir, folder, 'main.tex')),
      );
      yield* Effect.promise(() =>
        installPlatform({
          files: Object.fromEntries(
            files.map((file) => [
              path.join(runDir(runId), file),
              document(file),
            ]),
          ),
          storagePath,
          workspacePath,
          workspaceState: {
            [DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS]: true,
          },
        }),
      );
      const output = (round: number, folder: string): OutputFileInfo => ({
        source: `${folder}/main.tex`,
        round,
        location: runStorageFile(
          runId,
          path.join(`r${round}`, folder, 'main.tex'),
        ),
        lineage: {
          original: null,
          diffBase: runStorageFile(
            runId,
            path.join('original', folder, 'main.tex'),
          ),
        },
        diff: null,
      });
      const manager = new LatexDiffManager(
        spiedTrace(),
        runId,
        new RunFileService(runId, testWorkspaceRoots()),
        testWorkspaceRoots(),
      );

      const { entries } = yield* manager.handleLatexdiffOfOutput(
        1,
        [output(1, 'a'), output(1, 'b')],
        [output(0, 'a'), output(0, 'b')],
      );

      expect(
        entries.map((entry) =>
          entry.status === 'ok'
            ? fileLocationDisplayPath(entry.diff)
            : entry.error,
        ),
      ).toStrictEqual([
        path.join('diff', 'r1', 'a', 'main_diff.tex'),
        path.join('diff', 'r1', 'b', 'main_diff.tex'),
        path.join('diff', 'r1', 'a', 'main_diffr1r0.tex'),
        path.join('diff', 'r1', 'b', 'main_diffr1r0.tex'),
      ]);
    }).pipe(Effect.provide(compileFsLayer)),
  );
});
