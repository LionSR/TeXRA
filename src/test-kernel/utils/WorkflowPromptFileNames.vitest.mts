// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { beforeEach, describe, expect, it } from 'vitest';

// Local imports - test support
import { createFakePlatform } from '@test/support/FakePlatform';

// Local imports - agent output
import {
  getExtractedDocOutputFileName,
  getSafeDocumentRelativePath,
} from '@agent/utils/outputFileUtils';

// Local imports - prompt utilities
import {
  getListOfFiles,
  getPromptFileName,
  getXmlFormatFromFiles,
} from '@utils/prompt';

describe('workflow prompt file names', () => {
  beforeEach(async () => {
    const { initPlatform } = await import('@platform/platform');
    initPlatform(
      createFakePlatform({
        workspacePath: '/workspace',
        files: {
          '/workspace/chapter/main.tex': 'workspace text',
          '/outside/absolute.tex': 'external text',
        },
      }),
    );
  });

  it('uses workspace-relative names and external basenames in prompt variables', async () => {
    expect(getPromptFileName('/workspace/chapter/main.tex')).toBe(
      'chapter/main.tex',
    );
    expect(getPromptFileName('/outside/absolute.tex')).toBe('absolute.tex');
    expect(getPromptFileName('local.tex')).toBe('local.tex');

    expect(
      getListOfFiles(['/workspace/chapter/main.tex', '/outside/absolute.tex']),
    ).toBe('chapter/main.tex, absolute.tex');

    const xml = await getXmlFormatFromFiles([
      '/workspace/chapter/main.tex',
      '/outside/absolute.tex',
    ]);

    expect(xml).toContain('<document name="chapter/main.tex">');
    expect(xml).toContain('<document name="absolute.tex">');
    expect(xml).not.toContain('name="/outside/absolute.tex"');
  });

  it('keeps extracted outputs inside the round directory for absolute document names', () => {
    expect(getExtractedDocOutputFileName('chapter/main.tex', 'r0')).toBe(
      path.join('r0', 'chapter', 'main.tex'),
    );
    expect(getExtractedDocOutputFileName('/tmp/main.tex', 'r0')).toBe(
      path.join('r0', 'main.tex'),
    );
    expect(getExtractedDocOutputFileName('../main.tex', 'r0')).toBe(
      path.join('r0', 'main.tex'),
    );
    expect(getSafeDocumentRelativePath('/tmp/main.tex')).toBe('main.tex');
    expect(getSafeDocumentRelativePath('chapters/main.tex')).toBe(
      path.join('chapters', 'main.tex'),
    );
  });
});
