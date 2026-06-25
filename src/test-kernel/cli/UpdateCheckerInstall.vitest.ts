import { describe, expect, it } from 'vitest';

import {
  detectInstallMethod,
  isPackageManagerInstall,
} from '@cli/runtime/updateChecker';

describe('isPackageManagerInstall', () => {
  it('treats a global npm install (under node_modules) as managed', () => {
    expect(
      isPackageManagerInstall(
        '/usr/local/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
  });

  it('treats a Homebrew Cellar install as managed', () => {
    expect(
      isPackageManagerInstall(
        '/opt/homebrew/Cellar/texra/0.38.10/libexec/lib/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
  });

  it('treats a pnpm global install as managed', () => {
    expect(
      isPackageManagerInstall(
        '/Users/x/Library/pnpm/global/5/node_modules/@texra-ai/cli/dist/bin/texra.js',
      ),
    ).toBe(true);
  });

  it('is case-insensitive for Windows paths', () => {
    expect(
      isPackageManagerInstall(
        'C:\\Users\\x\\AppData\\Roaming\\npm\\node_modules\\@texra-ai\\cli\\dist\\bin\\texra.js',
      ),
    ).toBe(true);
  });

  it('treats a source/dev checkout as unmanaged', () => {
    expect(
      isPackageManagerInstall(
        '/Users/x/Local/AI-Projects/coauthor/packages/cli/dist/bin/texra.js',
      ),
    ).toBe(false);
  });

  it('treats a linked checkout outside node_modules as unmanaged', () => {
    expect(
      isPackageManagerInstall('/Users/x/.local/share/texra/dist/bin/texra.js'),
    ).toBe(false);
  });

  // The unmanaged-path guard exists precisely because detectInstallMethod
  // cannot tell a dev checkout apart from a global npm install: with none of
  // the brew/pnpm/yarn/bun segments present, it falls back to 'npm'.
  it('detectInstallMethod falls back to npm for an unmanaged dev path', () => {
    expect(
      detectInstallMethod(
        '/Users/x/Local/AI-Projects/coauthor/packages/cli/dist/bin/texra.js',
      ),
    ).toBe('npm');
  });
});
