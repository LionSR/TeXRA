// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - desktop test paths
import { repoPath } from './desktopTestPaths.mjs';

interface TsconfigJson {
  extends?: string;
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

function readTsconfig(relativePath: string): TsconfigJson {
  return JSON.parse(
    readFileSync(repoPath(relativePath), 'utf8'),
  ) as TsconfigJson;
}

function readText(relativePath: string): string {
  return readFileSync(repoPath(relativePath), 'utf8');
}

describe('build alias configuration', () => {
  it('uses the root alias table for desktop typecheck and bundling', () => {
    const rootPaths = readTsconfig('tsconfig.json').compilerOptions?.paths;
    const desktopPaths = readTsconfig('packages/desktop/tsconfig.paths.json')
      .compilerOptions?.paths;
    const desktopTsconfig = readTsconfig('packages/desktop/tsconfig.json');
    const viteConfig = readText('packages/desktop/vite.config.ts');

    expect(desktopTsconfig.extends).toBe('./tsconfig.paths.json');
    expect(desktopPaths).toEqual(rootPaths);
    expect(viteConfig).toContain("from '../../scripts/aliases.mjs'");
    expect(viteConfig).not.toContain('../extension/scripts/aliases.mjs');
  });

  it('uses generated TypeScript paths for extension bundling', () => {
    const extensionViteConfig = readText('packages/extension/vite.config.ts');
    const extensionEsbuildConfig = readText(
      'packages/extension/esbuild.config.mjs',
    );

    expect(extensionViteConfig).toContain("from '../../scripts/aliases.mjs'");
    expect(extensionViteConfig).not.toContain("from './scripts/aliases.mjs'");
    expect(extensionViteConfig).not.toContain(
      '.mjs import works at runtime via Vite',
    );
    expect(extensionEsbuildConfig).toContain("tsconfig: './tsconfig.json'");
    expect(extensionEsbuildConfig).not.toContain('aliasPlugin');
    expect(extensionEsbuildConfig).not.toContain(
      "from '../../scripts/aliases.mjs'",
    );
  });
});
