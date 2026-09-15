// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports
import { setupPlatform } from '@test/support/setupPlatform';
import { fakePath } from '@test/support/FakePlatform';
import {
  getListOfFiles,
  getPromptFileName,
  getXmlFormatFromReadableFiles,
} from '@utils/prompt';
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

  it('uses workspace-relative names and external basenames in prompt variables', async () => {
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

    const { xml } = await getXmlFormatFromReadableFiles(root, [
      fakePath('workspace/chapter/main.tex'),
      fakePath('outside/absolute.tex'),
    ]);

    expect(xml).toContain('<document name="chapter/main.tex">');
    expect(xml).toContain('<document name="absolute.tex">');
    expect(xml).not.toContain(`name="${fakePath('outside/absolute.tex')}"`);
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
