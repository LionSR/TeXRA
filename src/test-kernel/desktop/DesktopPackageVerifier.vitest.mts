// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop package verifier
import {
  normalizeMetafilePath,
  resolveMetafileImportPath,
} from '../../../scripts/desktop-package-metafile-paths.mjs';

describe('desktop package verifier metafile paths', () => {
  it('normalizes esbuild metafile keys to CWD-relative paths', () => {
    expect(normalizeMetafilePath('./dist/main/index.js')).toBe(
      'dist/main/index.js',
    );
    expect(normalizeMetafilePath('.\\dist\\main\\index.js')).toBe(
      'dist/main/index.js',
    );
  });

  it('resolves dot-prefixed chunk imports relative to their output', () => {
    expect(
      resolveMetafileImportPath('dist/main/index.js', './chunks/provider.js'),
    ).toBe('dist/main/chunks/provider.js');
    expect(
      resolveMetafileImportPath(
        'dist/main/chunks/startup.js',
        '../shared/provider.js',
      ),
    ).toBe('dist/main/shared/provider.js');
  });

  it('leaves CWD-relative import paths addressable as metafile keys', () => {
    expect(
      resolveMetafileImportPath(
        'dist/main/index.js',
        'dist/main/chunks/provider.js',
      ),
    ).toBe('dist/main/chunks/provider.js');
  });
});
