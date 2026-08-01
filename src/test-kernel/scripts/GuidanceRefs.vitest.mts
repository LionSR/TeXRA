import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = resolve(repoRoot, 'scripts/check-guidance-refs.mjs');
const fixtures = fileURLToPath(
  new URL('./fixtures/guidance-refs/', import.meta.url),
);

function runFixture(name: string) {
  return spawnSync(process.execPath, [scriptPath, resolve(fixtures, name)], {
    encoding: 'utf8',
  });
}

describe('check-guidance-refs Markdown links', () => {
  it('accepts balanced destinations and ignores link-like prose', () => {
    const result = runFixture('valid');

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('AGENTS.md, src/README.md');
  });

  it('reports broken inline, full-reference, and shortcut links', () => {
    const result = runFixture('broken');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('agent/core/missing.md');
    expect(result.stderr).toContain('missing.md');
    expect(result.stderr).toContain('nowhere.md');
    expect(result.stderr).toContain('collapsed.md');
  });

  it('reports broken reference-style images', () => {
    const result = runFixture('broken');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('nowhere.png');
  });
});
