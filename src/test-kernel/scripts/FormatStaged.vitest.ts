import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const formatScript = resolve(repoRoot, 'scripts/format-staged.mjs');
const installScript = resolve(repoRoot, 'scripts/install-local-hooks.mjs');

// Fixtures avoid string literals so the expected Prettier output is the same
// under the repo's `.prettierrc` and the scratch repo's empty one.
const BASE = 'export const x = 1;\n';
const STAGED = 'export const x = {a:1,b:2};\n';
const UNSTAGED = 'export const x = {a:1,b:2,c:3};\n';
const FORMATTED = 'export const x = { a: 1, b: 2 };\n';

const MULTI_STAGED = [
  'const a={x:1,y:2};',
  'export const b = 2;',
  'export const c = 3;',
  'export const d = 4;',
  'export const e = 5;',
  '',
].join('\n');
const MULTI_UNSTAGED = MULTI_STAGED.replace(
  'export const e = 5;',
  'export const e = 5;export const f = 6;',
);
const MULTI_FORMATTED = MULTI_STAGED.replace(
  'const a={x:1,y:2};',
  'const a = { x: 1, y: 2 };',
);
const MULTI_MERGED = MULTI_FORMATTED.replace(
  'export const e = 5;',
  'export const e = 5;export const f = 6;',
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'format-staged-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  writeFileSync(join(dir, '.prettierrc'), '{}\n');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function runFormat() {
  return spawnSync(process.execPath, [formatScript], {
    cwd: dir,
    encoding: 'utf8',
  });
}

function stagedBlob(path: string): string {
  return git(['show', `:${path}`]);
}

describe('format-staged', () => {
  it('stages Prettier output for a fully staged file', () => {
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(FORMATTED);
    // No unstaged change remains for the formatted file.
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('keeps unstaged hunks that overlap the reformat (#9955)', () => {
    writeFileSync(join(dir, 'a.ts'), BASE);
    git(['add', 'a.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);
    writeFileSync(join(dir, 'a.ts'), UNSTAGED);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('kept the working-tree copy');
    // The commit picks up the formatted staged content...
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
    // ...and the unstaged c:3 edit survives byte-identical in the tree.
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(UNSTAGED);
  });

  it('folds non-overlapping unstaged edits into the formatted file', () => {
    writeFileSync(
      join(dir, 'c.ts'),
      MULTI_STAGED.replace('{x:1,y:2}', '{x:1}'),
    );
    git(['add', 'c.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'c.ts'), MULTI_STAGED);
    git(['add', 'c.ts']);
    writeFileSync(join(dir, 'c.ts'), MULTI_UNSTAGED);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(stagedBlob('c.ts')).toBe(MULTI_FORMATTED);
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe(MULTI_MERGED);
    // Only the unstaged edit remains as a working-tree change.
    expect(git(['diff', '--stat', 'c.ts'])).toContain('1 insertion');
  });

  it('leaves ignored, unknown, and already-formatted files untouched', () => {
    writeFileSync(join(dir, '.prettierignore'), 'ignored.ts\n');
    writeFileSync(join(dir, 'ignored.ts'), STAGED);
    writeFileSync(join(dir, 'data.xyz123'), STAGED);
    writeFileSync(join(dir, 'clean.ts'), FORMATTED);
    git(['add', '.prettierignore', 'ignored.ts', 'data.xyz123', 'clean.ts']);

    const before = git(['ls-files', '-s']);
    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(git(['ls-files', '-s'])).toBe(before);
  });

  it('is a no-op when nothing is staged', () => {
    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('leaves staged content alone while a merge is in progress', () => {
    writeFileSync(join(dir, 'a.ts'), BASE);
    git(['add', 'a.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(
      join(dir, git(['rev-parse', '--git-dir']).trim(), 'MERGE_HEAD'),
      git(['rev-parse', 'HEAD']),
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(stagedBlob('a.ts')).toBe(STAGED);
  });
});

describe('install-local-hooks', () => {
  beforeEach(() => {
    // The engine resolves Prettier relative to its own path, so the shim's
    // `node scripts/format-staged.mjs` needs the script and a resolvable
    // `prettier` inside the scratch repo.
    mkdirSync(join(dir, 'scripts'));
    copyFileSync(formatScript, join(dir, 'scripts/format-staged.mjs'));
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(
      resolve(repoRoot, 'node_modules/prettier'),
      join(dir, 'node_modules/prettier'),
      'junction',
    );
    // Lets the installer chain pre-commit's shim when pre-commit is on PATH.
    writeFileSync(join(dir, '.pre-commit-config.yaml'), 'repos: []\n');
  });

  function runInstall() {
    return spawnSync(process.execPath, [installScript], {
      cwd: dir,
      encoding: 'utf8',
    });
  }

  it('installs a hook that auto-stages formatting without losing unstaged edits', () => {
    const install = runInstall();
    expect(install.status, install.stderr).toBe(0);
    const hookPath = resolve(
      dir,
      git(['rev-parse', '--git-path', 'hooks']).trim(),
      'pre-commit',
    );
    expect(existsSync(hookPath)).toBe(true);

    writeFileSync(join(dir, 'a.ts'), BASE);
    git(['add', 'a.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);
    writeFileSync(join(dir, 'a.ts'), UNSTAGED);

    const commit = spawnSync('git', ['commit', '-m', 'test'], {
      cwd: dir,
      encoding: 'utf8',
    });

    expect(commit.status, commit.stderr).toBe(0);
    expect(git(['show', 'HEAD:a.ts'])).toBe(FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(UNSTAGED);
  }, 60_000);

  it('is idempotent', () => {
    expect(runInstall().status).toBe(0);
    const rerun = runInstall();
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(rerun.stdout).toContain('format-staged');
  }, 30_000);

  it('refuses to overwrite an unrecognized hook', () => {
    const hookPath = resolve(
      dir,
      git(['rev-parse', '--git-path', 'hooks']).trim(),
      'pre-commit',
    );
    writeFileSync(hookPath, '#!/bin/sh\necho custom\n');

    const result = runInstall();

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Refusing to overwrite');
    expect(readFileSync(hookPath, 'utf8')).toContain('custom');
  }, 30_000);
});
