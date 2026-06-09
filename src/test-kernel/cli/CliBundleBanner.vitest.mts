import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('ESM bundle banner', () => {
  it('defines CommonJS globals for bundled dependencies', () => {
    const banner = readRepoFile('scripts/esm-cjs-globals-banner.mjs');

    expect(banner).toContain('__texraCreateRequire');
    expect(banner).toContain('const require = __texraCreateRequire');
    expect(banner).toContain('const __filename = __texraFileURLToPath');
    expect(banner).toContain('const __dirname = __texraDirname(__filename)');
  });

  it('uses the shared banner for bundled ESM entry points', () => {
    expect(readRepoFile('packages/cli/scripts/build-bundle.mjs')).toContain(
      'esmCjsGlobalsBanner',
    );
    expect(readRepoFile('packages/cli/scripts/build-harness.mjs')).toContain(
      'esmCjsGlobalsBanner',
    );
    expect(readRepoFile('packages/desktop/esbuild.main.mjs')).toContain(
      'esmCjsGlobalsBanner',
    );
  });
});
