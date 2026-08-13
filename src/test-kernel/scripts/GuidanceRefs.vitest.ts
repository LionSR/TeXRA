import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

  it('reports CRLF reference definitions', () => {
    const root = mkdtempSync(join(tmpdir(), 'guidance-refs-'));

    try {
      mkdirSync(join(root, 'src'));
      writeFileSync(
        join(root, 'src', 'README.md'),
        '[missing][target]\r\n\r\n[target]: crlf-reference-only.md\r\n',
      );
      const result = spawnSync(process.execPath, [scriptPath, root], {
        encoding: 'utf8',
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('crlf-reference-only.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
