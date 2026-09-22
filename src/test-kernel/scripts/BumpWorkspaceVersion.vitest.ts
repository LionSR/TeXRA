import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { withTempDir } from '@test/support/tempDirPlatform';

const repoRoot = process.cwd();
const scriptPath = path.join(repoRoot, 'scripts/bump-workspace-version.mjs');
const workflowPath = path.join(repoRoot, '.github/workflows/version-bump.yml');
const manifestPaths = [
  'package.json',
  'packages/agent/package.json',
  'packages/cli/package.json',
  'packages/desktop/package.json',
  'packages/extension/package.json',
  'packages/llm/package.json',
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

const TAG_FORMAT_ERROR =
  'Release tag must be MAJOR.MINOR.PATCH or MAJOR.MINOR.PATCH-preview.N, with an optional leading v or cli-v prefix.';

describe('bump-workspace-version script', () => {
  it('accepts CLI release tags when computing the next workspace version', async () => {
    await withTempDir('texra-version-bump-', async (root) => {
      await writeWorkspaceManifests(root, '0.38.10');

      const result = runVersionBump(['--from', 'cli-v0.38.9', '--check'], root);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('0.38.10\n');
      expect(result.stderr).toBe('');
    });
  });

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

  it('propagates a preview suffix to every manifest and rejects any other prerelease form', async () => {
    await withTempDir('texra-version-bump-', async (root) => {
      await writeWorkspaceManifests(root, '1.0.0-preview.1');

      const next = runVersionBump(['--from', 'v1.0.0-preview.1'], root);
      expect(next.status).toBe(0);
      expect(next.stdout).toBe('1.0.0-preview.2\n');
      await Promise.all(
        manifestPaths.map(async (manifestPath) => {
          const manifest = JSON.parse(
            await readFile(path.join(root, manifestPath), 'utf8'),
          ) as { version: string };
          expect(manifest.version).toBe('1.0.0-preview.2');
        }),
      );

      const rejected = runVersionBump(
        ['--from', 'v1.0.0-beta.1', '--check'],
        root,
      );
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain(TAG_FORMAT_ERROR);
    });
  });
});
