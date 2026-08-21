import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
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

const toCrlf = (text: string) => text.replaceAll('\n', '\r\n');

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

  it('keeps a CRLF worktree intact when core.autocrlf is on', () => {
    git(['config', 'core.autocrlf', 'true']);
    writeFileSync(join(dir, 'a.ts'), toCrlf(STAGED));
    git(['add', 'a.ts']);
    // autocrlf stores the LF blob even though the checkout is CRLF.
    expect(stagedBlob('a.ts')).toBe(STAGED);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(toCrlf(FORMATTED));
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('treats core.autocrlf=1 as a CRLF checkout (#10505)', () => {
    git(['config', 'core.autocrlf', '1']);
    writeFileSync(join(dir, 'a.ts'), toCrlf(STAGED));
    git(['add', 'a.ts']);
    expect(stagedBlob('a.ts')).toBe(STAGED);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(toCrlf(FORMATTED));
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('folds non-overlapping CRLF edits without a spurious merge conflict', () => {
    git(['config', 'core.autocrlf', 'true']);
    writeFileSync(
      join(dir, 'c.ts'),
      toCrlf(MULTI_STAGED.replace('{x:1,y:2}', '{x:1}')),
    );
    git(['add', 'c.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'c.ts'), toCrlf(MULTI_STAGED));
    git(['add', 'c.ts']);
    writeFileSync(join(dir, 'c.ts'), toCrlf(MULTI_UNSTAGED));

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(stagedBlob('c.ts')).toBe(MULTI_FORMATTED);
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe(toCrlf(MULTI_MERGED));
    expect(git(['diff', '--stat', 'c.ts'])).toContain('1 insertion');
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
    expect(result.stdout).toContain('mixed LF/CRLF line endings');
    // The staged blob is still formatted...
    expect(stagedBlob('c.ts')).toBe(MULTI_FORMATTED);
    // ...but no unstaged line's bytes are rewritten.
    expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toBe(mixed);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps newer worktree content if it appears during the merge-file write',
    () => {
      writeFileSync(
        join(dir, 'c.ts'),
        MULTI_STAGED.replace('{x:1,y:2}', '{x:1}'),
      );
      git(['add', 'c.ts']);
      git(['commit', '-qm', 'base']);
      writeFileSync(join(dir, 'c.ts'), MULTI_STAGED);
      git(['add', 'c.ts']);
      writeFileSync(join(dir, 'c.ts'), MULTI_UNSTAGED);

      // A fake git in PATH touches the worktree right before the real
      // `git merge-file` runs, simulating a concurrent edit after the hook
      // captured `worktree` but before it writes the merged result.
      const bin = mkdtempSync(join(tmpdir(), 'format-staged-git-'));
      const fakeGit = join(bin, 'git');
      const realGit = spawnSync('which', ['git'], {
        encoding: 'utf8',
      }).stdout.trim();
      writeFileSync(
        fakeGit,
        '#!/bin/sh\n' +
          'if [ "$1" = "merge-file" ]; then\n' +
          '  printf "const late = true;\\n" >> "$WORKTREE_FILE"\n' +
          'fi\n' +
          'exec "$REAL_GIT" "$@"\n',
      );
      chmodSync(fakeGit, 0o755);

      const result = runFormat({
        ...gitEnv,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        REAL_GIT: realGit,
        WORKTREE_FILE: join(dir, 'c.ts'),
      });

      rmSync(bin, { recursive: true, force: true });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('changed on disk while formatting');
      expect(stagedBlob('c.ts')).toBe(MULTI_FORMATTED);
      expect(readFileSync(join(dir, 'c.ts'), 'utf8')).toContain(
        'const late = true;',
      );
      expect(readFileSync(join(dir, 'c.ts'), 'utf8')).not.toContain(
        'const a = { x: 1, y: 2 };',
      );
    },
    60_000,
  );

  it('uses the staged .prettierrc when the worktree copy has unstaged edits', () => {
    writeFileSync(join(dir, '.prettierrc'), '{"singleQuote":true}\n');
    git(['add', '.prettierrc']);
    writeFileSync(join(dir, '.prettierrc'), '{"singleQuote":false}\n');
    writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe("const x = 'a';\n");
  });

  it('snapshots a diverged extensionless YAML .prettierrc (#10500)', () => {
    writeFileSync(join(dir, '.prettierrc'), 'singleQuote: true\n');
    git(['add', '.prettierrc']);
    writeFileSync(join(dir, '.prettierrc'), 'singleQuote: false\n');
    writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe("const x = 'a';\n");
  });

  it('leaves a clean extensionless YAML config with an unstaged dependency to Prettier (#10504)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, '.prettierrc'),
      'plugins:\n  - "./fake-plugin.mjs"\n',
    );
    git(['add', '.prettierrc', 'fake-plugin.mjs']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'fake-plugin.mjs'),
      'export default {};\n// edit\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(result.stdout).not.toContain('fake-plugin.mjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
  });

  it('uses the staged .prettierignore when the worktree copy has unstaged edits', () => {
    writeFileSync(join(dir, '.prettierignore'), 'ignored.ts\n');
    git(['add', '.prettierignore']);
    writeFileSync(join(dir, '.prettierignore'), '');
    writeFileSync(join(dir, 'ignored.ts'), STAGED);
    git(['add', 'ignored.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    expect(stagedBlob('ignored.ts')).toBe(STAGED);
  });

  it('skips auto-staging when the nearest config is untracked (#10367)', () => {
    mkdirSync(join(dir, 'src'));
    // A nearer, untracked config must not shape the staged blob.
    writeFileSync(join(dir, 'src/.prettierrc'), '{"semi":false}\n');
    writeFileSync(join(dir, 'src/a.ts'), STAGED);
    git(['add', 'src/a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('src/.prettierrc is not staged');
    expect(stagedBlob('src/a.ts')).toBe(STAGED);
  });

  it('applies overrides relative to a staged config with unstaged edits (#10368)', () => {
    writeFileSync(
      join(dir, '.prettierrc'),
      '{"overrides":[{"files":"src/**","options":{"semi":false}}]}\n',
    );
    git(['add', '.prettierrc']);
    // Unstaged edit drops the override; the staged config must still win,
    // resolved against the config's own directory.
    writeFileSync(join(dir, '.prettierrc'), '{}\n');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src/a.ts'), 'export const x = 1;\n');
    git(['add', 'src/a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for src/a.ts');
    expect(stagedBlob('src/a.ts')).toBe('export const x = 1\n');
  });

  it('resolves plugins relative to a staged config with unstaged edits (#10368)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, '.prettierrc'),
      '{"plugins":["./fake-plugin.mjs"]}\n',
    );
    git(['add', 'fake-plugin.mjs', '.prettierrc']);
    writeFileSync(join(dir, '.prettierrc'), '{}\n');
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
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

  it('stages Prettier output in a SHA-256 object-format repo (#10370)', () => {
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    git(['init', '-q', '-b', 'main', '--object-format=sha256']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'test']);
    git(['config', 'commit.gpgsign', 'false']);
    git(['add', '.prettierrc']);
    git(['commit', '-qm', 'init']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);
    // SHA-256 repos carry 64-hex object names in the index.
    expect(git(['ls-files', '-s', '--', 'a.ts'])).toMatch(/ [0-9a-f]{64} /);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
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
      expect(result.stdout).toContain('a.ts');
      expect(result.stdout).toContain('already exists; skipped auto-staging');
      expect(stagedBlob('a.ts')).toBe('const x = "a";\n');
      const snapshots = readdirSync(dir).filter((name) =>
        name.startsWith('.prettierrc-format-staged-'),
      );
      expect(snapshots).toHaveLength(1);
      expect(readFileSync(join(dir, snapshots[0]), 'utf8')).toBe('precious\n');
    },
    60_000,
  );

  it('strips a UTF-8 BOM before parsing a staged package.json (#10430)', () => {
    writeFileSync(
      join(dir, 'package.json'),
      `\uFEFF${JSON.stringify({ prettier: { singleQuote: true } })}\n`,
    );
    git(['add', 'package.json']);
    // The worktree copy is BOM-less so Prettier still selects package.json;
    // the staged blob is the BOM-prefixed one the snapshot must parse.
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ prettier: { singleQuote: false } })}\n`,
    );
    writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe("const x = 'a';\n");
  });

  it('uses the staged package.json prettier key when it diverges (#10431)', () => {
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":{"singleQuote":true}}\n',
    );
    git(['add', 'package.json']);
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":{"singleQuote":false}}\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe("const x = 'a';\n");
  });

  it('falls through to defaults when the staged package.json has no prettier key (#10431)', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n');
    git(['add', 'package.json']);
    git(['commit', '-qm', 'package base']);
    // The worktree copy gains a `prettier` key, so Prettier selects package.json,
    // but the staged manifest it must draw rules from has none.
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":{"singleQuote":true}}\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
  });

  it('skips auto-staging when a staged package.yaml diverges (#10431)', () => {
    writeFileSync(
      join(dir, 'package.yaml'),
      'prettier:\n  singleQuote: true\n',
    );
    git(['add', 'package.yaml']);
    writeFileSync(
      join(dir, 'package.yaml'),
      'prettier:\n  singleQuote: false\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'package.yaml configs cannot be snapshotted',
    );
    expect(stagedBlob('a.ts')).toBe('const x = "a";\n');
  });

  it('skips a clean package.yaml whose relative plugin has unstaged edits (#10501)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, 'package.yaml'),
      'prettier:\n  plugins:\n    - "./fake-plugin.mjs"\n',
    );
    git(['add', 'fake-plugin.mjs', 'package.yaml']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'fake-plugin.mjs'),
      'export default {};\n// edit\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('fake-plugin.mjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe(STAGED);
  });

  it('does not append extensions for an extensionless package.yaml plugin (#10501)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, 'package.yaml'),
      'prettier:\n  plugins:\n    - "./fake-plugin"\n',
    );
    git(['add', 'fake-plugin.mjs', 'package.yaml']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    // Prettier's plugin loader does not append extensions, so the hook must
    // verify the literal specifier rather than invent a .mjs fallback.
    expect(result.stdout).toContain('fake-plugin is not staged');
    expect(stagedBlob('a.ts')).toBe(STAGED);
  });

  it('skips a clean package.yaml pointer target whose dependency is unstaged (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts.cjs");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'config/opts.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.yaml'),
      'prettier: "./config/prettier.cjs"\n',
    );
    git(['add', 'config/prettier.cjs', 'config/opts.cjs', 'package.yaml']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'config/opts.cjs'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('config/opts.cjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('updates a fully staged mixed-EOL file in the working tree (#10432)', () => {
    const mixed = MULTI_STAGED.replace(
      'const a={x:1,y:2};\n',
      'const a={x:1,y:2};\r\n',
    );
    writeFileSync(join(dir, 'a.ts'), mixed);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(MULTI_FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(MULTI_FORMATTED);
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('writes formatted output verbatim for a fully staged mixed-EOL CRLF file (#10505)', () => {
    writeFileSync(join(dir, '.prettierrc'), '{"endOfLine":"crlf"}\n');
    git(['add', '.prettierrc']);
    git(['commit', '-qm', 'crlf config']);
    const mixed = MULTI_STAGED.replace(
      'const a={x:1,y:2};\n',
      'const a={x:1,y:2};\r\n',
    );
    writeFileSync(join(dir, 'a.ts'), mixed);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(toCrlf(MULTI_FORMATTED));
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(
      toCrlf(MULTI_FORMATTED),
    );
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('writes CRLF formatted output verbatim for a fully staged LF file (#10505)', () => {
    writeFileSync(join(dir, '.prettierrc'), '{"endOfLine":"crlf"}\n');
    git(['add', '.prettierrc']);
    git(['commit', '-qm', 'crlf config']);
    writeFileSync(join(dir, 'a.ts'), MULTI_STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(toCrlf(MULTI_FORMATTED));
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(
      toCrlf(MULTI_FORMATTED),
    );
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('writes LF formatted output verbatim for a fully staged CRLF file (#10505)', () => {
    writeFileSync(join(dir, '.prettierrc'), '{"endOfLine":"lf"}\n');
    git(['add', '.prettierrc']);
    git(['commit', '-qm', 'lf config']);
    writeFileSync(join(dir, 'a.ts'), toCrlf(MULTI_STAGED));
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(MULTI_FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(MULTI_FORMATTED);
    expect(git(['diff', '--name-only', '--', 'a.ts'])).toBe('');
  });

  it('keeps an unstaged CRLF conversion when the index blob is LF (#10505)', () => {
    writeFileSync(join(dir, 'a.ts'), BASE);
    git(['add', 'a.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);
    // Byte-different but normalized-equal worktree: this is an unstaged
    // line-ending conversion, not a fully staged file, and must survive.
    writeFileSync(join(dir, 'a.ts'), toCrlf(STAGED));

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(toCrlf(FORMATTED));
  });

  it('does not treat an autocrlf package.yaml checkout as divergent (#10433)', () => {
    git(['config', 'core.autocrlf', 'true']);
    writeFileSync(
      join(dir, 'package.yaml'),
      toCrlf('prettier:\n  singleQuote: true\n'),
    );
    git(['add', 'package.yaml']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'const x = "a";\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(result.stdout).not.toContain(
      'package.yaml configs cannot be snapshotted',
    );
    expect(stagedBlob('a.ts')).toBe("const x = 'a';\n");
  });

  it('skips a staged config whose relative plugin has unstaged edits (#10434)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, '.prettierrc'),
      '{"plugins":["./fake-plugin.mjs"]}\n',
    );
    git(['add', 'fake-plugin.mjs', '.prettierrc']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, '.prettierrc'), '{}\n');
    writeFileSync(
      join(dir, 'fake-plugin.mjs'),
      'export default {};\n// edit\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('fake-plugin.mjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe(STAGED);
  });

  it('skips a diverged JavaScript config whose relative import is unstaged (#10434)', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src/.prettierrc.mjs'),
      'import opts from "./opts.mjs";\nexport default opts;\n',
    );
    writeFileSync(
      join(dir, 'src/opts.mjs'),
      'export default { semi: false };\n',
    );
    git(['add', 'src/.prettierrc.mjs', 'src/opts.mjs']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'src/.prettierrc.mjs'),
      'export default { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'src/opts.mjs'),
      'export default { semi: true };\n',
    );
    writeFileSync(join(dir, 'src/a.ts'), 'export const x = 1;\n');
    git(['add', 'src/a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('src/opts.mjs has unstaged edits');
    expect(stagedBlob('src/a.ts')).toBe('export const x = 1;\n');
  });

  it('leaves a clean JavaScript config with an unstaged dependency to Prettier (#10504)', () => {
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'src/.prettierrc.mjs'),
      'import opts from "./opts.mjs";\nexport default opts;\n',
    );
    writeFileSync(
      join(dir, 'src/opts.mjs'),
      'export default { semi: false };\n',
    );
    git(['add', 'src/.prettierrc.mjs', 'src/opts.mjs']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'src/opts.mjs'),
      'export default { semi: true };\n',
    );
    writeFileSync(join(dir, 'src/a.ts'), STAGED);
    git(['add', 'src/a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for src/a.ts');
    expect(result.stdout).not.toContain('src/opts.mjs has unstaged edits');
    // Prettier resolves the clean config from the working tree, so the
    // unstaged semi:true dependency wins; the hook must not skip the commit.
    expect(stagedBlob('src/a.ts')).toBe(FORMATTED);
  });

  it('leaves a clean package.json object config with an unstaged dependency to Prettier (#10504)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":{"plugins":["./fake-plugin.mjs"]}}\n',
    );
    git(['add', 'package.json', 'fake-plugin.mjs']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'fake-plugin.mjs'),
      'export default {};\n// edit\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(result.stdout).not.toContain('fake-plugin.mjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
  });

  it('leaves a clean JSON .prettierrc with an unstaged dependency to Prettier (#10504)', () => {
    writeFileSync(join(dir, 'fake-plugin.mjs'), 'export default {};\n');
    writeFileSync(
      join(dir, '.prettierrc'),
      '{"plugins":["./fake-plugin.mjs"]}\n',
    );
    git(['add', '.prettierrc', 'fake-plugin.mjs']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'fake-plugin.mjs'),
      'export default {};\n// edit\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(result.stdout).not.toContain('fake-plugin.mjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe(FORMATTED);
  });

  it('sources a string-pointer prettier config from the index (#10435)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'package.json']);
    git(['commit', '-qm', 'config base']);
    // Diverges package.json (so the pointer path is snapshotted) and the
    // pointed-to config. The staged pointer target must win over the worktree.
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs","name":"x"}\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('skips a clean JS pointer target whose relative dependency is unstaged (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts.cjs");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'config/opts.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'config/opts.cjs', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'config/opts.cjs'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('config/opts.cjs has unstaged edits');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('skips a diverged package.json bare package-name pointer (#10503)', () => {
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"@company/prettier-config"}\n',
    );
    git(['add', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"@company/prettier-config","name":"x"}\n',
    );
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "package.json's prettier key names the shareable config",
    );
    expect(stagedBlob('a.ts')).toBe(STAGED);
  });

  it('resolves a Windows-style package.json prettier pointer (#10503)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ prettier: '.\\config\\prettier.cjs' })}\n`,
    );
    git(['add', 'config/prettier.cjs', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('does not append .cjs for an extensionless CommonJS require (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'config/opts.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'config/opts.cjs', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    // Node's CJS LOAD_AS_FILE does not try .cjs for require('./opts'), so the
    // literal dependency path is not staged and the hook skips accordingly.
    expect(result.stdout).toContain('config/opts is not staged');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('resolves an extensionless CommonJS dependency to its .js file (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'config/opts.js'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'config/opts.js', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(result.stdout).not.toContain('config/opts is not staged');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('resolves an extensionless CommonJS require to its .json file (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(join(dir, 'config/opts.json'), '{ "semi": false }\n');
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'config/opts.json', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(result.stdout).not.toContain('config/opts is not staged');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('resolves an extensionless CommonJS dependency through directory package main (#10502)', () => {
    mkdirSync(join(dir, 'config/opts'), { recursive: true });
    writeFileSync(
      join(dir, 'config/opts/package.json'),
      '{"main":"main.cjs"}\n',
    );
    writeFileSync(
      join(dir, 'config/opts/main.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git([
      'add',
      'config/prettier.cjs',
      'config/opts/package.json',
      'config/opts/main.cjs',
      'package.json',
    ]);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('resolves an extensionless CommonJS dependency through directory index (#10502)', () => {
    mkdirSync(join(dir, 'config/opts'), { recursive: true });
    writeFileSync(
      join(dir, 'config/opts/index.js'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'config/opts/index.js', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('does not follow an untracked directory package.json redirect (#10502)', () => {
    mkdirSync(join(dir, 'config/opts'), { recursive: true });
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'config/evil.cjs'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'config/evil.cjs', 'package.json']);
    git(['commit', '-qm', 'config base']);
    // The redirect manifest exists only in the worktree, so index resolution
    // must ignore it instead of resolving ./opts to the tracked evil.cjs.
    writeFileSync(
      join(dir, 'config/opts/package.json'),
      '{"main":"./evil.cjs"}\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('config/opts/package.json is not staged');
    expect(result.stdout).not.toContain('config/evil.cjs');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('skips when a directory package main manifest has unstaged edits (#10502)', () => {
    mkdirSync(join(dir, 'config/opts'), { recursive: true });
    writeFileSync(
      join(dir, 'config/opts/package.json'),
      '{"main":"./good.cjs"}\n',
    );
    writeFileSync(
      join(dir, 'config/opts/good.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git([
      'add',
      'config/prettier.cjs',
      'config/opts/package.json',
      'config/opts/good.cjs',
      'package.json',
    ]);
    git(['commit', '-qm', 'config base']);
    writeFileSync(
      join(dir, 'config/opts/package.json'),
      '{"main":"./good.cjs","x":1}\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'config/opts/package.json has unstaged edits',
    );
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('honors package main over index fallback for extensionless require (#10502)', () => {
    mkdirSync(join(dir, 'config/opts'), { recursive: true });
    writeFileSync(
      join(dir, 'config/opts/package.json'),
      '{"main":"main.cjs"}\n',
    );
    writeFileSync(
      join(dir, 'config/opts/main.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'config/opts/index.js'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git([
      'add',
      'config/prettier.cjs',
      'config/opts/package.json',
      'config/opts/main.cjs',
      'config/opts/index.js',
      'package.json',
    ]);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('skips when an extensionless package main target has unstaged edits (#10591)', () => {
    mkdirSync(join(dir, 'config/opts'), { recursive: true });
    writeFileSync(join(dir, 'config/opts/package.json'), '{"main":"main"}\n');
    writeFileSync(
      join(dir, 'config/opts/main.js'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'config/opts/index.js'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git([
      'add',
      'config/prettier.cjs',
      'config/opts/package.json',
      'config/opts/main.js',
      'config/opts/index.js',
      'package.json',
    ]);
    git(['commit', '-qm', 'config base']);
    // The real main target (`main.js`, via Node's LOAD_AS_FILE on the
    // extensionless main) is edited in the working tree; the package-level
    // index.js fallback stays clean. The hook must resolve the main target
    // and skip rather than format with the uncommitted semi:false rules.
    writeFileSync(
      join(dir, 'config/opts/main.js'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('config/opts/main.js has unstaged edits');
    expect(result.stdout).not.toContain('config/opts/index.js has unstaged');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('skips when a directory package main target has unstaged edits (#10591)', () => {
    mkdirSync(join(dir, 'config/opts/dist'), { recursive: true });
    writeFileSync(join(dir, 'config/opts/package.json'), '{"main":"dist"}\n');
    writeFileSync(
      join(dir, 'config/opts/dist/index.js'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'config/opts/index.js'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git([
      'add',
      'config/prettier.cjs',
      'config/opts/package.json',
      'config/opts/dist/index.js',
      'config/opts/index.js',
      'package.json',
    ]);
    git(['commit', '-qm', 'config base']);
    // The real main target (`dist/index.js`, via Node's LOAD_INDEX on the
    // directory main) is edited; the package-level index.js stays clean.
    writeFileSync(
      join(dir, 'config/opts/dist/index.js'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      'config/opts/dist/index.js has unstaged edits',
    );
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('does not append extensions for an extensionless ESM import (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.mjs'),
      'import opts from "./opts";\nexport default opts;\n',
    );
    writeFileSync(
      join(dir, 'config/opts.js'),
      'export default { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.mjs"}\n',
    );
    git(['add', 'config/prettier.mjs', 'config/opts.js', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    // Node ESM does not append .js to a relative import, so the literal
    // dependency path is not staged and the hook skips.
    expect(result.stdout).toContain('config/opts is not staged');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('reports the literal path when an extensionless dependency has no candidate (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./missing");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git(['add', 'config/prettier.cjs', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('config/missing is not staged');
    expect(stagedBlob('a.ts')).toBe('export const x = 1;\n');
  });

  it('uses deterministic CJS first-match when .js and .cjs both exist (#10502)', () => {
    mkdirSync(join(dir, 'config'));
    writeFileSync(
      join(dir, 'config/prettier.cjs'),
      'const opts = require("./opts");\nmodule.exports = opts;\n',
    );
    writeFileSync(
      join(dir, 'config/opts.js'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'config/opts.cjs'),
      'module.exports = { semi: true };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"./config/prettier.cjs"}\n',
    );
    git([
      'add',
      'config/prettier.cjs',
      'config/opts.js',
      'config/opts.cjs',
      'package.json',
    ]);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    // Node's CJS LOAD_AS_FILE order picks opts.js before any other candidate.
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('resolves a package-name shareable config from node_modules (#10503)', () => {
    mkdirSync(join(dir, 'node_modules/@company/prettier-config'), {
      recursive: true,
    });
    writeFileSync(
      join(dir, 'node_modules/@company/prettier-config/package.json'),
      '{"name":"@company/prettier-config","main":"index.cjs"}\n',
    );
    writeFileSync(
      join(dir, 'node_modules/@company/prettier-config/index.cjs'),
      'module.exports = { semi: false };\n',
    );
    writeFileSync(
      join(dir, 'package.json'),
      '{"prettier":"@company/prettier-config"}\n',
    );
    git(['add', 'package.json']);
    git(['commit', '-qm', 'config base']);
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('staged Prettier output for a.ts');
    expect(stagedBlob('a.ts')).toBe('export const x = 1\n');
  });

  it('skips auto-staging when .prettierignore is untracked (#10436)', () => {
    writeFileSync(join(dir, '.prettierignore'), 'ignored.ts\n');
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);

    const result = runFormat();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('.prettierignore is not staged');
    expect(stagedBlob('a.ts')).toBe(STAGED);
  });
});

describe('install-local-hooks', () => {
  const hasPreCommit = spawnSync('pre-commit', ['--version']).status === 0;

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
    symlinkSync(
      resolve(repoRoot, 'node_modules/ignore'),
      join(dir, 'node_modules/ignore'),
      'junction',
    );
    symlinkSync(
      resolve(repoRoot, 'node_modules/yaml'),
      join(dir, 'node_modules/yaml'),
      'junction',
    );
    // Lets the installer chain pre-commit's shim when pre-commit is on PATH.
    writeFileSync(join(dir, '.pre-commit-config.yaml'), 'repos: []\n');
  });

  function runInstall() {
    return spawnSync(process.execPath, [installScript], {
      cwd: dir,
      encoding: 'utf8',
      env: gitEnv,
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
    // Pin the commit to the fixture's own hooks dir now that pre-commit has
    // already been installed (it refuses to install while hooksPath is set).
    git([
      'config',
      'core.hooksPath',
      resolve(dir, git(['rev-parse', '--git-path', 'hooks']).trim()),
    ]);

    writeFileSync(join(dir, 'a.ts'), BASE);
    git(['add', 'a.ts']);
    git(['commit', '-qm', 'base']);
    writeFileSync(join(dir, 'a.ts'), STAGED);
    git(['add', 'a.ts']);
    writeFileSync(join(dir, 'a.ts'), UNSTAGED);

    const commit = spawnSync('git', ['commit', '-m', 'test'], {
      cwd: dir,
      encoding: 'utf8',
      env: gitEnv,
    });

    expect(commit.status, commit.stderr).toBe(0);
    expect(git(['show', 'HEAD:a.ts'])).toBe(FORMATTED);
    expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(UNSTAGED);
  }, 60_000);

  it.skipIf(process.platform === 'win32')(
    'does not touch the index when pre-commit runs the legacy shim',
    () => {
      const hooksDir = resolve(
        dir,
        git(['rev-parse', '--git-path', 'hooks']).trim(),
      );
      const hookPath = join(hooksDir, 'pre-commit');
      const legacyPath = join(hooksDir, 'pre-commit.legacy');

      expect(runInstall().status).toBe(0);
      renameSync(hookPath, legacyPath);

      writeFileSync(join(dir, 'a.ts'), STAGED);
      git(['add', 'a.ts']);

      const legacy = spawnSync(legacyPath, [], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...gitEnv, PRE_COMMIT_RUNNING_LEGACY: '1' },
      });

      expect(legacy.status, legacy.stderr).toBe(0);
      expect(stagedBlob('a.ts')).toBe(STAGED);
      expect(readFileSync(join(dir, 'a.ts'), 'utf8')).toBe(STAGED);
    },
    30_000,
  );

  it.skipIf(!hasPreCommit)(
    'refreshes the chained pre-commit shim on reinstall',
    () => {
      const hooksDir = resolve(
        dir,
        git(['rev-parse', '--git-path', 'hooks']).trim(),
      );
      const hookPath = join(hooksDir, 'pre-commit');
      const chainPath = join(hooksDir, 'pre-commit.chain');

      expect(runInstall().status).toBe(0);
      expect(existsSync(chainPath)).toBe(true);
      writeFileSync(chainPath, '#!/bin/sh\necho stale\n');

      const rerun = runInstall();

      expect(rerun.status, rerun.stderr).toBe(0);
      expect(readFileSync(chainPath, 'utf8')).toContain(
        'File generated by pre-commit',
      );
      expect(readFileSync(hookPath, 'utf8')).toContain('texra-format-staged');
    },
    30_000,
  );

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
