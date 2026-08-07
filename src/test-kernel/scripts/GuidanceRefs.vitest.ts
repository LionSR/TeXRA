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

  it('reports broken inline, reference, and shortcut links plus broken images', () => {
    const result = runFixture('broken');

    expect(result.status).toBe(1);
    for (const missing of [
      'agent/core/missing.md',
      'missing.md',
      'nowhere.md',
      'collapsed.md',
      'nowhere.png',
    ]) {
      expect(result.stderr).toContain(missing);
    }
  });
});
