// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

// Local imports
import {
  setupPlatform,
  fakeProcessServices,
} from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import { getListOfFiles, getPromptFileName } from '@utils/prompt';
import { getXmlFormatFromReadableFiles } from '@utils/files/varsUtils';
import {
  getExtractedDocOutputFileName,
  getSafeDocumentRelativePath,
} from '@utils/files/outputFileUtils';

describe('workflow prompt file names', () => {
  setupPlatform({
    workspacePath: fakePath('workspace'),
    files: {
      '/workspace/chapter/main.tex': 'workspace text',
      '/outside/absolute.tex': 'external text',
    },
  });

  const root = fakePath('workspace');

  it.effect(
    'uses workspace-relative names and external basenames in prompt variables',
    () =>
      Effect.gen(function* () {
        expect(
          getPromptFileName(root, fakePath('workspace/chapter/main.tex')),
        ).toBe('chapter/main.tex');
        expect(getPromptFileName(root, fakePath('outside/absolute.tex'))).toBe(
          'absolute.tex',
        );
        expect(getPromptFileName(root, 'local.tex')).toBe('local.tex');

        expect(
          getListOfFiles(root, [
            fakePath('workspace/chapter/main.tex'),
            fakePath('outside/absolute.tex'),
          ]),
        ).toBe('chapter/main.tex, absolute.tex');

        const { xml } = yield* getXmlFormatFromReadableFiles(root, [
          fakePath('workspace/chapter/main.tex'),
          fakePath('outside/absolute.tex'),
        ]);

        expect(xml).toContain('<document name="chapter/main.tex">');
        expect(xml).toContain('<document name="absolute.tex">');
        expect(xml).not.toContain(`name="${fakePath('outside/absolute.tex')}"`);
      }).pipe(Effect.provide(fakeProcessServices())),
  );

  // #12803: with no workspace root, a relative entry makes
  // `workspaceAbsolutePath` throw. Resolved as an argument that throw was a
  // defect outside the per-file recovery and failed the whole batch; it must
  // skip the one file and keep the readable ones.
  it('skips a relative entry with no workspace root instead of failing the batch', async () => {
    const { xml, skipped } = await testRuntime().runPromise(
      getXmlFormatFromReadableFiles(undefined, [
        'relative.tex',
        fakePath('outside/absolute.tex'),
      ]),
    );

    expect(xml).toContain('<document name="absolute.tex">');
    expect(skipped.map((entry) => entry.file)).toEqual(['relative.tex']);
  });

  it('keeps extracted outputs inside the round directory for absolute document names', () => {
    expect(getExtractedDocOutputFileName('chapter/main.tex', 'r0')).toBe(
      'r0/chapter/main.tex',
    );
    expect(getExtractedDocOutputFileName('/tmp/main.tex', 'r0')).toBe(
      'r0/main.tex',
    );
    expect(getExtractedDocOutputFileName('../main.tex', 'r0')).toBe(
      'r0/main.tex',
    );
    expect(getSafeDocumentRelativePath('/tmp/main.tex')).toBe('main.tex');
    expect(getSafeDocumentRelativePath('chapters/main.tex')).toBe(
      'chapters/main.tex',
    );
  });
});
