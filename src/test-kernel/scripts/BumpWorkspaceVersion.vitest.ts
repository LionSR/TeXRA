import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts/bump-workspace-version.mjs');
const manifestPaths = [
  'package.json',
  'packages/core/package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
  'packages/extension/package.json',
];

async function writeWorkspaceManifests(root: string, version: string) {
  await Promise.all(
    manifestPaths.map(async (manifestPath) => {
      const absolutePath = path.join(root, manifestPath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${JSON.stringify({ version })}\n`);
    }),
  );
}

function runVersionBump(args: readonly string[], cwd = repoRoot) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

describe('bump-workspace-version script', () => {
  it('accepts CLI release tags when computing the next workspace version', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'texra-version-bump-'));
    try {
      await writeWorkspaceManifests(root, '0.38.10');

      const result = runVersionBump(['--from', 'cli-v0.38.9', '--check'], root);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('0.38.10\n');
      expect(result.stderr).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('documents the accepted release tag prefixes in parse errors', () => {
    const result = runVersionBump(['--from', 'v0.8.5-frontend', '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Release tag must be MAJOR.MINOR.PATCH, with an optional leading v or cli-v prefix.',
    );
    expect(result.stderr).toContain(
      'node scripts/bump-workspace-version.mjs --from cli-v0.37.10',
    );
  });

  it('rejects CLI-prefixed release tags without the tag v', () => {
    const result = runVersionBump(['--from', 'cli-0.38.9', '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Release tag must be MAJOR.MINOR.PATCH, with an optional leading v or cli-v prefix.',
    );
  });
});
