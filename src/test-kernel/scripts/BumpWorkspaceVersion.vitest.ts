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
  'Release tag must be MAJOR.MINOR.PATCH, with an optional leading v or cli-v prefix.';

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

  it('documents the accepted release tag prefixes in parse errors', () => {
    const result = runVersionBump(['--from', 'v0.8.5-frontend', '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(TAG_FORMAT_ERROR);
    expect(result.stderr).toContain(
      'node scripts/bump-workspace-version.mjs --from cli-v0.37.10',
    );
  });

  it('rejects CLI-prefixed release tags without the tag v', () => {
    const result = runVersionBump(['--from', 'cli-0.38.9', '--check']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(TAG_FORMAT_ERROR);
  });
});

describe('version-bump workflow', () => {
  it('installs frozen dependencies before running the version bump script', async () => {
    const workflow = parseYaml(await readFile(workflowPath, 'utf8')) as {
      jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
    };
    const steps = workflow.jobs?.['bump-version']?.steps ?? [];
    const installIndex = steps.findIndex(
      (step) =>
        step.name === 'Install dependencies' &&
        step.run?.trim() === 'pnpm install --frozen-lockfile',
    );
    const bumpIndex = steps.findIndex((step) =>
      step.run?.includes('node scripts/bump-workspace-version.mjs'),
    );

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(bumpIndex).toBeGreaterThan(installIndex);
  });
});
