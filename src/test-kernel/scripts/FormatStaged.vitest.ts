import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const formatScript = resolve(repoRoot, 'scripts/format-staged.mjs');

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

let dir: string;
let gitEnv = process.env;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'format-staged-'));
  const emptyGitConfig = join(dir, 'empty-gitconfig');
  writeFileSync(emptyGitConfig, '');
  // Isolate git from host global/system config so the fixture does not
  // inherit commit signing or a non-default core.hooksPath. This also keeps
  // `pre-commit install` happy, since it refuses to run when hooksPath is
  // set to any non-empty value.
  gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, '.prettierrc'), '{}\n');
  // The hook skips files whose worktree-selected config is untracked
  // (#10367), so the fixture config starts out committed.
  git(['add', '.prettierrc']);
  git(['commit', '-qm', 'init']);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function git(args: string[]): string {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: gitEnv,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function runFormat(env = gitEnv) {
  return spawnSync(process.execPath, [formatScript], {
    cwd: dir,
    encoding: 'utf8',
    env,
  });
}

function stagedBlob(path: string): string {
  return git(['show', `:${path}`]);
}

describe('format-staged', () => {
  it('keeps unstaged hunks that overlap the reformat (#9955)', () => {
    writeFileSync(join(dir, 'a.ts'), BASE);
    git(['add', 'a.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);
    writeFileSync(join(dir, 'a.ts'), UNSTAGED);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    // The commit picks up the formatted staged content...
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
    // ...and the unstaged c:3 edit survives byte-identical in the tree.
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(UNSTAGED);
  });

  it('leaves a mixed-EOL working tree byte-identical (#10369)', () => {
    writeFileSync(
      join(dir, 'c.ts'),
      MULTI_STAGED.replace('{x:1,y:2}', '{x:1}'),
    );
    git(['add', 'c.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'c.ts'), MULTI_STAGED);
    git(['add', 'c.ts']);
    // Unstaged edit with mixed endings: one CRLF line among LF lines.
    const mixed = MULTI_UNSTAGED.replace(
      'const a={x:1,y:2};\n',
      'const a={x:1,y:2};\r\n',
    );
    writeFileSync(join(dir, 'c.ts'), mixed);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    // The staged blob is still formatted...
    expect(stagedBlob('c.ts')).toBe(MULTI_FORMATTED);
    // ...but no unstaged line's bytes are rewritten.
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe(mixed);
  });

  it.skipIf(process.platform === 'win32')(
    'never overwrites or deletes an untracked snapshot-path file (#10429)',
    () => {
      writeFileSync(join(dir, '.prettierrc'), '{"singleQuote":true}\n');
      git(['add', '.prettierrc']);
      writeFileSync(join(dir, '.prettierrc'), '{"singleQuote":false}\n');
      writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
      git(['add', 'a.ts']);

      // The snapshot name embeds the child's PID. `$$` is the shell's PID,
      // and `exec` replaces the shell with node without changing it, so this
      // pre-creates exactly the snapshot path the script will try to use.
      const result = spawnSync(
        'sh',
        [
          '-c',
          `printf 'precious\\n' > .prettierrc-format-staged-$$ && exec ` +
            `${JSON.stringify(process.execPath)} ${JSON.stringify(formatScript)}`,
        ],
        { cwd: dir, encoding: 'utf8', env: gitEnv },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(stagedBlob('a.ts')).toBe('const x = "a";\n');
      const snapshots = readdirSync(dir).filter((name) =>
        name.startsWith('.prettierrc-format-staged-'),
      );
      expect(snapshots).toHaveLength(1);
      expect(readFileSync(join(dir, snapshots[0]), 'utf8')).toBe('precious\n');
    },
    60_000,
  );
});
