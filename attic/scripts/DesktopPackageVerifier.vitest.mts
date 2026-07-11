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
  it.each<{ desc: string; label: string; expected: string[] }>([
    {
      desc: 'uses the packaged artifact path for arch-specific macOS apps (arm64)',
      label:
        'packages/desktop/dist-packaged/mac-arm64/TeXRA.app/Contents/Resources/app.asar',
      expected: ['darwin-arm64'],
    },
    {
      desc: 'uses the packaged artifact path for arch-specific macOS apps (x64)',
      label:
        'packages/desktop/dist-packaged/mac-x64/TeXRA.app/Contents/Resources/app.asar',
      expected: ['darwin-x64'],
    },
    {
      desc: 'keeps universal macOS apps on both Darwin Codex binaries',
      label:
        'packages/desktop/dist-packaged/mac-universal/TeXRA.app/Contents/Resources/app.asar',
      expected: ['darwin-x64', 'darwin-arm64'],
    },
    {
      desc: 'uses the Linux arm64 architecture label instead of the verifier host',
      label: 'packages/desktop/dist-packaged/TeXRA-0.37.8-linux-arm64.AppImage',
      expected: ['linux-arm64'],
    },
    {
      desc: 'uses the win-x64 architecture label instead of the verifier host',
      label: 'packages/desktop/dist-packaged/TeXRA-0.37.8-win-x64.exe',
      expected: ['win32-x64'],
    },
    {
      desc: 'uses the win32-arm64 architecture label instead of the verifier host',
      label: 'packages/desktop/dist-packaged/TeXRA-0.37.8-win32-arm64.exe',
      expected: ['win32-arm64'],
    },
    {
      desc: 'does not classify Darwin labels as Windows',
      label: 'packages/desktop/dist-packaged/TeXRA-0.37.8-darwin-x64.zip',
      expected: [],
    },
  ])('$desc', ({ label, expected }) => {
    expect(expectedCodexPlatformKeysFromLabel(label)).toEqual(expected);
  });
});
