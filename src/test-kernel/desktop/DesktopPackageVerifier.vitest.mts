// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop package verifier
import {
  normalizeMetafilePath,
  resolveMetafileImportPath,
} from '../../../scripts/desktop-package-metafile-paths.mjs';
import { expectedCodexPlatformKeysFromLabel } from '../../../scripts/desktop-package-targets.mjs';

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

  it('does not treat package-like dot-prefixed paths as relative imports', () => {
    expect(
      resolveMetafileImportPath('dist/main/index.js', '.pnpm/chunk.js'),
    ).toBe('.pnpm/chunk.js');
  });
});

describe('desktop package verifier target inference', () => {
  it('uses the packaged artifact path for arch-specific macOS apps', () => {
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/mac-arm64/TeXRA.app/Contents/Resources/app.asar',
      ),
    ).toEqual(['darwin-arm64']);
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/mac-x64/TeXRA.app/Contents/Resources/app.asar',
      ),
    ).toEqual(['darwin-x64']);
  });

  it('keeps universal macOS apps on both Darwin Codex binaries', () => {
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/mac-universal/TeXRA.app/Contents/Resources/app.asar',
      ),
    ).toEqual(['darwin-x64', 'darwin-arm64']);
  });

  it('uses Linux and Windows architecture labels instead of the verifier host', () => {
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/TeXRA-0.37.8-linux-arm64.AppImage',
      ),
    ).toEqual(['linux-arm64']);
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/TeXRA-0.37.8-win-x64.exe',
      ),
    ).toEqual(['win32-x64']);
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/TeXRA-0.37.8-win32-arm64.exe',
      ),
    ).toEqual(['win32-arm64']);
  });

  it('does not classify Darwin labels as Windows', () => {
    expect(
      expectedCodexPlatformKeysFromLabel(
        'packages/desktop/dist-packaged/TeXRA-0.37.8-darwin-x64.zip',
      ),
    ).toEqual([]);
  });
});
