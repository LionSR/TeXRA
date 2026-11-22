// Node imports
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

// Local imports
import {
  RunIdSchema,
  fileLocationDisplayPath,
} from '@texra-ai/worldline/schemas';
import { RunWorkspace } from '@texra/tools/documents/runWorkspace';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { spiedTrace } from '@test/support/spiedTrace';
import { FakeHost } from '@test/support/testKernel';
import { TEXRA_APP } from '@test/support/texraApp';
import type { OutputFileInfo } from '@texra/shared/plugins/documentOutputs';
import { revisionLatexdiffs } from '@texra/agent/output/revisionLatexdiffs';

// Local file imports
import { compileFsLayer, runStorageFile } from './compileCheckTestUtils';
import { LATEXDIFF_BETWEEN_ROUNDS_SETTING } from '@texra/shared/settings/documentsSettings';

/** The process edge: every command exits 0 printing a document. That is
 *  latexdiff's diff; latexmk's output is ignored and it writes no PDF, so
 *  no diff PDF is published and only the `.tex` paths remain. */
const tools = scriptedSpawnerLayer(() => ({
  stdout:
    '\\documentclass{article}\n\\begin{document}\nchanged\n\\end{document}\n',
}));

const runId = Schema.decodeUnknownSync(RunIdSchema)('d1ff0a');
const document = (body: string) =>
  `\\documentclass{article}\\begin{document}${body}\\end{document}`;
const files = ['original', 'r0', 'r1'].flatMap((dir) =>
  ['a', 'b'].map((folder) => path.join(dir, folder, 'main.tex')),
);
/** The run's directory as a seed key: under the host's default storage
 *  root, `workspace/.texra/storage`, where `runStorageFile` reads it. */
const seededRunDir = path.join('/workspace/.texra/storage/executions', runId);

// Two documents sharing a file name: each pair's diff once landed on the
// same flat `diff/r1/main_diff.tex`, the second overwriting the first.
layer(
  FakeHost.layer({
    app: TEXRA_APP,
    files: Object.fromEntries(
      files.map((file) => [path.join(seededRunDir, file), document(file)]),
    ),
    workspaceState: {
      [LATEXDIFF_BETWEEN_ROUNDS_SETTING.key]: true,
    },
  }),
  { excludeTestServices: true },
)('workflow LaTeX compile input directories', (it) => {
  it.effect("writes each document's latexdiffs under its own folder", () =>
    Effect.gen(function* () {
      const { roots } = yield* FakeHost;
      const output = (round: number, folder: string): OutputFileInfo => ({
        source: `${folder}/main.tex`,
        round,
        location: runStorageFile(
          roots,
          runId,
          path.join(`r${round}`, folder, 'main.tex'),
        ),
        lineage: {
          base: runStorageFile(
            roots,
            runId,
            path.join('original', folder, 'main.tex'),
          ),
          document: null,
        },
        diff: null,
      });
      const { entries } = yield* revisionLatexdiffs(
        {
          run: {
            logger: spiedTrace(),
            fileService: new RunWorkspace(runId, roots),
          },
          roots,
        },
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
    }).pipe(Effect.provide([compileFsLayer, tools.layer])),
  );
});
