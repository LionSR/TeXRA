// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

interface TsconfigJson {
  extends?: string;
  compilerOptions?: {
    paths?: Record<string, string[]>;
  };
}

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR = resolve(TEST_DIR, '../../..');

function readTsconfig(relativePath: string): TsconfigJson {
  return JSON.parse(
    readFileSync(resolve(ROOT_DIR, relativePath), 'utf8'),
  ) as TsconfigJson;
}

function readText(relativePath: string): string {
  return readFileSync(resolve(ROOT_DIR, relativePath), 'utf8');
}

describe('desktop alias configuration', () => {
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
});
