import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@test/support/tempDirPlatform';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts/bump-workspace-version.mjs');
const manifestPaths = [
  'package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
  'packages/extension/package.json',
  'packages/texra/package.json',
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
  it('rolls a patch train over .10 to an even minor from 1.0 on, keeping 0.x on minor + 1', async () => {
    await withTempDir('texra-version-bump-', async (root) => {
      await writeWorkspaceManifests(root, '1.2.0');

      const stable = runVersionBump(['--from', 'v1.0.10', '--check'], root);
      expect(stable.status).toBe(0);
      expect(stable.stdout).toBe('1.2.0\n');

      await writeWorkspaceManifests(root, '0.39.0');

      const zero = runVersionBump(['--from', 'v0.38.10', '--check'], root);
      expect(zero.status).toBe(0);
      expect(zero.stdout).toBe('0.39.0\n');
    });
  });
});
