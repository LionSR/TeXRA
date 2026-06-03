import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function readRepoFile(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

describe('CLI ESM bundle banner', () => {
  it('defines CommonJS globals for bundled dependencies', () => {
    const banner = readRepoFile(
      'packages/cli/scripts/esm-cjs-globals-banner.mjs',
    );

    expect(banner).toContain('__texraCreateRequire');
    expect(banner).toContain('const require = __texraCreateRequire');
    expect(banner).toContain('const __filename = __texraFileURLToPath');
    expect(banner).toContain('const __dirname = __texraDirname(__filename)');
  });

  it('uses the shared banner for both CLI ESM bundles', () => {
    expect(readRepoFile('packages/cli/scripts/build-bundle.mjs')).toContain(
      'esmCjsGlobalsBanner',
    );
    expect(readRepoFile('packages/cli/scripts/build-harness.mjs')).toContain(
      'esmCjsGlobalsBanner',
    );
  });
});
