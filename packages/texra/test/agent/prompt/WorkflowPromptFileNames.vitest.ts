// Node imports
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

// Local imports
import { labelFileName } from '@texra-ai/worldline/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { FakeHost } from '@test/support/testKernel';
import {
  getExtractedDocOutputFileName,
  getSafeDocumentRelativePath,
} from '@texra/utils/files/outputFileUtils';
import { readFilesAsPromptXml } from '@texra/tools/documents/promptDocuments';

layer(
  FakeHost.layer({
    files: {
      '/workspace/chapter/main.tex': 'workspace text',
      '/outside/absolute.tex': 'external text',
    },
  }),
  { buildPerTest: true },
)('workflow prompt file names', (it) => {
  // #12803: with no workspace root, a relative entry makes
  // `workspaceAbsolutePath` throw. Resolved as an argument that throw was a
  // defect outside the per-file recovery and failed the whole batch; it must
  // skip the one file and keep the readable ones.
  it.effect(
    'skips a relative entry with no workspace root instead of failing the batch',
    () =>
      Effect.gen(function* () {
        const host = yield* FakeHost;
        const { xml, skipped } = yield* readFilesAsPromptXml(undefined, [
          'relative.tex',
          host.path('outside/absolute.tex'),
        ]);

        expect(xml).toContain('<document name="absolute.tex">');
        expect(skipped.map((entry) => entry.file)).toEqual(['relative.tex']);
      }).pipe(Effect.provide(nodePlatformLayer)),
  );

  it('keeps extracted outputs inside the round directory for absolute document names', () => {
    expect(getExtractedDocOutputFileName('/tmp/main.tex', 'r0')).toBe(
      'r0/main.tex',
    );
    expect(getExtractedDocOutputFileName('../main.tex', 'r0')).toBe(
      'r0/main.tex',
    );
    expect(getSafeDocumentRelativePath('/tmp/main.tex')).toBe('main.tex');
  });

  // A run's label is text a model writes; packing names a folder under
  // History/ with it, which must stay one segment inside that folder.
  it('names a run by one path segment whatever its label says', () => {
    for (const label of ['x/../../archive', '..\\..\\archive', '..']) {
      const segment = labelFileName(label);
      expect(path.posix.join('History', segment).split('/')).toStrictEqual([
        'History',
        segment,
      ]);
      expect(segment).not.toMatch(/^\.|[\\/]/);
    }
  });
});
