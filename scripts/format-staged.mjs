#!/usr/bin/env node
// Auto-stage Prettier output for staged files, outside pre-commit's stash
// lifecycle.
//
// Why this runs outside pre-commit: pre-commit stashes unstaged changes
// around every hook it runs, and when a hook's edits collide with that stash
// it rolls back with `git checkout -- .` — restoring the working tree from
// the index. A hook that rewrites the index (`git add` after
// `prettier --write`, as attempted in #9953) turns that rollback into data
// loss: unstaged hunks survive only in a pre-commit cache patch (#9955).
//
// Instead, scripts/install-local-hooks.mjs installs this script as a plain
// git pre-commit hook chained AHEAD of pre-commit's shim. At that point no
// stash has happened: the index holds exactly the staged content and the
// working tree still holds any unstaged edits, so formatting is staged and
// merged back without ever discarding working-tree content:
//
//   1. Format each staged file's index blob (`git cat-file blob <sha>`), not
//      the working-tree file.
//   2. Stage the formatted blob (`git update-index --cacheinfo`), so the
//      commit picks up Prettier's output with no manual re-staging.
//   3. Fold the same formatting into the working tree with a three-way
//      `git merge-file` (base = staged blob). On conflict — the #9953 case,
//      where unstaged hunks overlap the reformat — the working tree is left
//      byte-identical and a notice explains how to sync. Unstaged work is
//      never overwritten.
//
// By the time pre-commit's shim runs, staged content is already formatted,
// so the `npm-format` hook makes no changes and pre-commit's stash/restore
// has nothing to conflict with. Contributors without the chained hook keep
// the previous write-and-fail behaviour; `npm run format:check` gates in CI.
//
// Formatting assistance is best-effort: this script warns and exits 0 rather
// than blocking a commit when it cannot format a file.

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
} from 'node:path';

import ignore from 'ignore';
import prettier from 'prettier';
import { parse as parseYaml } from 'yaml';

const NOTICE = '[format-staged]';

const CRLF = Buffer.from('\r\n');

const CJS_FILE_EXTENSIONS = ['.js', '.json', '.node'];
const CJS_INDEX_EXTENSIONS = ['index.js', 'index.json', 'index.node'];

/** Intentional skip: logged loudly as a notice and never treated as a crash. */
class SkipError extends Error {}

/** Run a git command, returning stdout as a Buffer; throw on failure. */
function git(args, { input } = {}) {
  const result = spawnSync('git', args, {
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/** True when `core.autocrlf=true`, so Git checks out the index's LF blobs
 * as CRLF and a CRLF worktree convention must be preserved. */
function isAutocrlfCheckout() {
  const result = spawnSync(
    'git',
    ['config', '--bool', '--get', 'core.autocrlf'],
    { encoding: 'utf8' },
  );
  return result.status === 0 && result.stdout.trim() === 'true';
}

/** Return a tracked path's index blob, or null when it is not tracked. */
function readIndexFile(path) {
  const check = spawnSync('git', ['cat-file', '-e', `:${path}`]);
  if (check.status !== 0) return null;
  return git(['cat-file', 'blob', `:${path}`]);
}

/** Mirror prettier's ignore handling against the staged .prettierignore. */
function isIgnored(path) {
  const ignoreBlob = readIndexFile('.prettierignore');
  if (ignoreBlob) {
    const rules = `${ignoreBlob.toString('utf8')}\nnode_modules`;
    return ignore({ allowRelativePaths: true }).add(rules).checkIgnore(path)
      .ignored;
  }
  if (existsSync('.prettierignore')) {
    throw new SkipError(
      '.prettierignore is not staged; skipped auto-staging so its ' +
        'uncommitted rules stay out of the commit. Stage or remove it and ' +
        'retry.',
    );
  }
  return ignore({ allowRelativePaths: true })
    .add('node_modules')
    .checkIgnore(path).ignored;
}

/** Write `content` only if `path` still holds `expected`, so a concurrent edit
 * made while formatting/merging was running is never clobbered. */
function writeIfUnchanged(path, expected, content) {
  let current;
  try {
    current = readFileSync(path);
  } catch {
    console.log(
      `${NOTICE} ${path}: vanished while formatting; kept the staged output.`,
    );
    return;
  }
  if (!current.equals(expected)) {
    console.log(
      `${NOTICE} ${path}: changed on disk while formatting; kept the working-tree copy.`,
    );
    return;
  }
  writeFileSync(path, content);
}

/** Normalize CRLF line endings to LF for index/worktree comparison and
 * merge-file inputs. */
function normalizeLf(buffer) {
  if (!buffer.includes(CRLF)) return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

/** Return `content` using the working-tree copy's line-ending convention. */
function withWorktreeEol(content, worktree) {
  const lf = normalizeLf(content);
  if (!worktree.includes(CRLF)) return lf;
  return Buffer.from(lf.toString('utf8').replace(/\n/g, '\r\n'), 'utf8');
}

/** True when `buffer` mixes CRLF and bare-LF newlines. */
function hasMixedEol(buffer) {
  if (!buffer.includes(CRLF)) return false;
  const text = buffer.toString('utf8');
  return text.replace(/\r\n/g, '').includes('\n');
}

/** Strip a leading UTF-8 BOM before parsing JSON/YAML config content. */
function stripBom(text) {
  return text.replace(/^\uFEFF/, '');
}

/** True when `a` and `b` differ only by CRLF/LF line endings. */
function normalizedEquals(a, b) {
  return normalizeLf(a).equals(normalizeLf(b));
}

/** Return `path` relative to the repo root with forward slashes, or null when
 * it lives outside the repository. */
function relToCwd(path) {
  const rel = relative(process.cwd(), path).replace(/\\/g, '/');
  if (rel.startsWith('../') || rel === '..') return null;
  return rel;
}

/** True for `.js`, `.cjs`, and `.mjs` Prettier config files. */
function isJsConfig(path) {
  return /\.(?:c?js|mjs)$/.test(path);
}

/** Normalize Windows-style separator backslashes in a config specifier to
 * forward slashes, so `./x`/`../x` and `.\x`/`..\x` classify the same way and
 * POSIX path resolution treats them identically. */
function normalizeSpecifier(spec) {
  return spec.replace(/\\/g, '/');
}

/** True for `./x` and `../x` dependency specifiers, in either slash style. */
function isRelativeSpecifier(spec) {
  const normalized = normalizeSpecifier(spec);
  return normalized.startsWith('./') || normalized.startsWith('../');
}

/** True for filesystem paths Prettier accepts as a package.json `prettier`
 * pointer (`./x`, `../x`, or an absolute path), as opposed to a shareable
 * config package name resolved from node_modules. */
function isConfigPointerPath(spec) {
  return isRelativeSpecifier(spec) || isAbsolute(spec);
}

/** True when `path` is a regular file in the working tree. Node's
 * LOAD_AS_FILE/tryExtensions classify with stat, so a symlink to a file
 * counts: admitting the link as a candidate makes an untracked one a loud
 * "not staged" skip instead of a silent fall-through to a fallback Node
 * would never load. */
function isWorktreeFile(path) {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/** Return the `main` entry of a dependency directory's package.json. The
 * manifest itself must be tracked and equal to its index blob before its
 * redirect is trusted; otherwise an untracked or unstaged `main` edit could
 * route Prettier to uncommitted rules. Throws when the manifest is present in
 * only one of the index/worktree or differs between them. */
function readPackageMain(dir) {
  const pkgPath = join(dir, 'package.json');
  const pkgRel = relToCwd(pkgPath);
  if (!pkgRel) return null;
  const stagedPkg = readIndexFile(pkgRel);
  if (!stagedPkg) {
    if (existsSync(pkgPath)) {
      throw new SkipError(
        `${pkgRel} is not staged but the config depends on it; skipped ` +
          'auto-staging so its uncommitted manifest stays out of the commit.',
      );
    }
    return null;
  }
  if (!existsSync(pkgPath)) {
    throw new SkipError(
      `${pkgRel} vanished from the working tree; skipped auto-staging.`,
    );
  }
  if (!normalizedEquals(readFileSync(pkgPath), stagedPkg)) {
    throw new SkipError(
      `${pkgRel} has unstaged edits while the config depends on it; ` +
        'skipped auto-staging so the uncommitted manifest stays out of the commit.',
    );
  }
  try {
    const main = JSON.parse(stripBom(stagedPkg.toString('utf8'))).main;
    return typeof main === 'string' ? main : null;
  } catch {
    return null;
  }
}

/** True when `path` is tracked in the index. */
function isIndexTracked(path) {
  const rel = relToCwd(path);
  return rel !== null && readIndexFile(rel) !== null;
}

/** True when any component of `path`, from the repository root down to the
 * path itself, is a worktree symlink. Node loads a module by realpath and
 * resolves its own relative dependencies from the real directory, so an
 * index blob at the lexical path proves nothing about the dependency context
 * Node actually sees; such a path must fail loudly rather than verify. */
function pathTraversesSymlink(path) {
  const rel = relToCwd(path);
  if (rel === null) return false;
  let current = process.cwd();
  for (const segment of rel.split('/')) {
    current = join(current, segment);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

/** Resolve a relative config dependency specifier to the tracked file
 * Node/Prettier would load, without executing any config. `kind` is `cjs`
 * for `require()`/CommonJS resolution; every other kind (ESM `import`,
 * `export ... from`, dynamic `import()`, and Prettier plugin paths) is exact
 * and gets no extension or directory-index fallback, matching the loaders. */
function resolveConfigDepPath(configDir, spec, kind) {
  const normalized = normalizeSpecifier(spec);
  const base = resolve(configDir, normalized);
  if (kind !== 'cjs' || parse(normalized).ext !== '') return base;

  // Node's CommonJS LOAD_AS_FILE order: exact path, then .js, .json, .node.
  // LOAD_AS_DIRECTORY follows with package.json `main` (index-sourced only),
  // then index.js/index.json/index.node. First present candidate wins; the
  // subsequent verifyConfigDep check reports it as untracked/diverged if the
  // winning candidate is not the committed dependency.
  const candidates = [];
  const push = (candidate) => {
    if (isWorktreeFile(candidate) || isIndexTracked(candidate)) {
      candidates.push(candidate);
    }
  };

  push(base);
  for (const ext of CJS_FILE_EXTENSIONS) push(`${base}${ext}`);

  // Node applies LOAD_AS_DIRECTORY only when LOAD_AS_FILE found no file:
  // an admitted file candidate wins outright and the directory's package
  // main/index.* are never inspected, so an irrelevant directory beside the
  // winner (for example an untracked symlinked package) must not force a
  // skip either. stat, not lstat: Node's LOAD_AS_DIRECTORY follows a
  // symlinked dependency directory too. Candidates reached through the link
  // traverse a worktree symlink, which verifyConfigDep rejects loudly, so
  // following the link here can never verify the wrong file.
  if (
    candidates.length === 0 &&
    statSync(base, { throwIfNoEntry: false })?.isDirectory()
  ) {
    const main = readPackageMain(base);
    if (main) {
      const mainTarget = resolve(base, normalizeSpecifier(main));
      // Node applies LOAD_AS_FILE / LOAD_INDEX to the package main target
      // too, so an extensionless main (`"main": "main"` -> main.js) or a
      // directory main (`"main": "dist"` -> dist/index.js) resolves to the
      // real file. Verify that target before the package-level index.*
      // fallback below; otherwise the hook would check the wrong file and let
      // an unstaged edit to the real main drive Prettier.
      push(mainTarget);
      for (const ext of CJS_FILE_EXTENSIONS) push(`${mainTarget}${ext}`);
      // stat, not lstat: Node's LOAD_AS_DIRECTORY follows symlinks, so a
      // main target that links to a directory resolves to its index.*.
      // Classifying the link itself would skip those candidates and verify
      // the package-level index.* fallback Node never loads (#10602).
      if (statSync(mainTarget, { throwIfNoEntry: false })?.isDirectory()) {
        for (const indexName of CJS_INDEX_EXTENSIONS) {
          push(join(mainTarget, indexName));
        }
      }
    }
    for (const indexName of CJS_INDEX_EXTENSIONS) {
      push(join(base, indexName));
    }
  }

  return candidates[0] ?? base;
}

/** Verify one relative config dependency against its index blob. */
function verifyConfigDep(configDir, spec, kind = 'exact') {
  const depPath = resolveConfigDepPath(configDir, spec, kind);
  const depRel = relToCwd(depPath);
  if (!depRel) {
    throw new SkipError(
      `config dependency ${spec} resolves outside the repository; skipped ` +
        'auto-staging.',
    );
  }
  if (pathTraversesSymlink(depPath)) {
    throw new SkipError(
      `${depRel} resolves through a worktree symlink while the staged config ` +
        'depends on it; skipped auto-staging so the realpath target and its ' +
        'uncommitted dependencies stay out of the commit.',
    );
  }
  const stagedDep = readIndexFile(depRel);
  if (!stagedDep) {
    throw new SkipError(
      `${depRel} is not staged but the staged config depends on it; ` +
        'skipped auto-staging so its uncommitted rules stay out of the ' +
        'commit. Stage or remove it and retry.',
    );
  }
  if (!existsSync(depPath)) {
    throw new SkipError(
      `${depRel} vanished from the working tree; skipped auto-staging.`,
    );
  }
  if (!normalizedEquals(readFileSync(depPath), stagedDep)) {
    throw new SkipError(
      `${depRel} has unstaged edits while the staged config depends on it; ` +
        'skipped auto-staging so the uncommitted copy stays out of the commit.',
    );
  }
}

/** Verify relative `plugins`/`extends` entries from a parsed config value. */
function verifyDepSpecs(config, configDir) {
  if (!config || typeof config !== 'object') return;
  const deps = new Set();
  if (Array.isArray(config.plugins)) {
    for (const plugin of config.plugins) {
      if (typeof plugin === 'string' && isRelativeSpecifier(plugin)) {
        deps.add(plugin);
      }
    }
  }
  if (
    typeof config.extends === 'string' &&
    isRelativeSpecifier(config.extends)
  ) {
    deps.add(config.extends);
  }
  for (const dep of deps) verifyConfigDep(configDir, dep);
}

/** Collect relative JS config specifiers with the loader that consumes them.
 * `cjs` means Node's CommonJS `require()` resolution; `esm` and `plugin` are
 * exact path loads (Prettier plugins and Node ESM do not append extensions). */
function collectJsRelativeDeps(source) {
  const deps = new Map();
  const addSpec = (spec, kind) => {
    if (!isRelativeSpecifier(spec)) return;
    if (!deps.has(spec)) deps.set(spec, new Set());
    deps.get(spec).add(kind);
  };

  const esmPatterns = [
    /\bimport\s+[\s\S]*?\s+from\s*['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+[\s\S]*?\s+from\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of esmPatterns) {
    let match;
    while ((match = pattern.exec(source))) addSpec(match[1], 'esm');
  }

  const requirePattern = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let requireMatch;
  while ((requireMatch = requirePattern.exec(source))) {
    addSpec(requireMatch[1], 'cjs');
  }

  const pluginsPattern = /\bplugins\s*:\s*\[([^\]]*)\]/g;
  let block;
  while ((block = pluginsPattern.exec(source))) {
    const stringPattern = /['"]([^'"]+)['"]/g;
    let match;
    while ((match = stringPattern.exec(block[1]))) addSpec(match[1], 'plugin');
  }
  return deps;
}

/** Verify a JavaScript config's statically-visible relative dependencies. */
function verifyJsConfigDeps(configPath, configBlob) {
  const source = stripBom(configBlob.toString('utf8'));
  const configDir = dirname(configPath);
  for (const [dep, kinds] of collectJsRelativeDeps(source)) {
    verifyConfigDep(configDir, dep, kinds.has('cjs') ? 'cjs' : 'exact');
  }
}

/** Verify relative dependencies of a full config blob. `strict` controls
 * whether an unparsable/unsupported config forces a skip. Callers use this
 * only when the hook is about to hand Prettier index-sourced config content
 * (a snapshot or an explicitly resolved pointer target): clean configs that
 * Prettier resolves from the working tree are left to Prettier's own loader. */
function verifyConfigDeps(configPath, configBlob, strict) {
  const ext = parse(configPath).ext.toLowerCase();
  const text = stripBom(configBlob.toString('utf8'));
  const unparsable = () => {
    throw new SkipError(
      `cannot parse ${relToCwd(configPath)} to verify its relative ` +
        'dependencies; skipped auto-staging.',
    );
  };
  let value;
  if (ext === '.json') {
    try {
      value = JSON.parse(text);
    } catch {
      if (strict) unparsable();
      return;
    }
  } else if (ext === '') {
    // Prettier parses an extensionless `.prettierrc` with its YAML loader,
    // and JSON is a YAML subset, so one YAML parse covers both forms.
    try {
      value = parseYaml(text);
    } catch {
      if (strict) unparsable();
      return;
    }
  } else if (ext === '.yaml' || ext === '.yml') {
    try {
      value = parseYaml(text);
    } catch {
      if (strict) unparsable();
      return;
    }
  } else if (strict) {
    throw new SkipError(
      `cannot verify relative dependencies for ${relToCwd(configPath)}; ` +
        'skipped auto-staging.',
    );
  } else {
    return;
  }
  verifyDepSpecs(value, dirname(configPath));
}

/** Fold the staged→formatted rewrite into the working tree, if safe. */
function mergeWorktree(path, stagedBlob, formatted) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  // Unstaged deletion or a symlink replacing the file: leave the tree alone.
  if (!stat?.isFile()) return;
  const worktree = readFileSync(path);
  const stagedLf = normalizeLf(stagedBlob);
  const worktreeLf = normalizeLf(worktree);
  // Fully staged file: the rewrite applies cleanly by construction, even when
  // the tree's newlines are mixed. With no unstaged lines to protect, write
  // the formatted output back so the commit doesn't leave the whole file as a
  // new unstaged change. The index has just been staged with `formatted`
  // verbatim, so write those exact bytes back — even when Prettier chose a
  // different EOL than the worktree's uniform convention. The one exception
  // is an autocrlf=true checkout, where Git checks the index's LF blob out as
  // CRLF; preserve the tree's CRLF convention there. A normalized-equal but
  // byte-different worktree without that checkout conversion is an unstaged
  // EOL edit, so it falls through to the merge path below.
  const fullyStaged =
    worktree.equals(stagedBlob) ||
    (isAutocrlfCheckout() && worktreeLf.equals(stagedLf));
  if (fullyStaged) {
    const content =
      isAutocrlfCheckout() && worktree.includes(CRLF)
        ? withWorktreeEol(formatted, worktree)
        : formatted;
    writeIfUnchanged(path, worktree, content);
    return;
  }
  // A mixed-EOL working tree has no single convention to re-apply, and
  // rewriting every newline would flip the bytes of unrelated unstaged
  // lines. Leave it byte-identical; the staged output is already staged.
  if (hasMixedEol(worktree)) {
    console.log(
      `${NOTICE} ${path}: mixed LF/CRLF line endings; kept the working-tree ` +
        'copy. Run `npm run format` after committing to sync.',
    );
    return;
  }
  // autocrlf checks out CRLF files whose index blobs are LF. Normalize both
  // sides before comparing/merging, then re-apply the tree's EOL on write so
  // CRLF worktrees don't take a spurious conflict and don't get flipped to LF.
  // Unstaged edits exist. Three-way merge (base = staged blob) so they ride
  // along with the formatting; on conflict keep the working tree untouched.
  const dir = mkdtempSync(join(tmpdir(), 'format-staged-'));
  try {
    const base = join(dir, 'base');
    const ours = join(dir, 'ours');
    const theirs = join(dir, 'theirs');
    writeFileSync(base, stagedLf);
    writeFileSync(ours, worktreeLf);
    writeFileSync(theirs, normalizeLf(formatted));
    // merge-file exits with the conflict count, so any nonzero status means
    // the merge is not clean and the working tree must stay as it is.
    const result = spawnSync('git', ['merge-file', '-p', ours, base, theirs], {
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status === 0) {
      writeIfUnchanged(
        path,
        worktree,
        withWorktreeEol(result.stdout, worktree),
      );
    } else {
      console.log(
        `${NOTICE} ${path}: Prettier output overlaps your unstaged edits; ` +
          'kept the working-tree copy. Run `npm run format` after committing ' +
          'to sync.',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Write the staged config blob beside the worktree config it shadows,
 * under a scratch name that keeps the config's own directory and extension.
 * Overrides, relative plugins, and relative imports in the staged config then
 * resolve exactly as they do for the worktree file. The file is created
 * exclusively so a stale snapshot from a crashed run is never overwritten or
 * deleted. */
function writeConfigSnapshot(worktreeConfigPath, stagedConfig) {
  const base = basename(worktreeConfigPath);
  // package.json contributes only its `prettier` key, so the snapshot holds
  // just that key; every other config file is its own config.
  const content =
    base === 'package.json'
      ? JSON.stringify(
          JSON.parse(stripBom(stagedConfig.toString('utf8'))).prettier ?? null,
        )
      : stagedConfig;
  const { name, ext } = parse(base);
  const snapshotPath = join(
    dirname(worktreeConfigPath),
    `${name}-format-staged-${process.pid}${ext}`,
  );
  try {
    writeFileSync(snapshotPath, content, { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new SkipError(
        `${relToCwd(snapshotPath)} already exists; skipped auto-staging ` +
          'rather than overwriting an untracked file.',
      );
    }
    throw error;
  }
  return snapshotPath;
}

/** Decide how to resolve a staged config from the index. Returns the config
 * path to hand to Prettier (null means "resolve from the working tree as
 * usual") plus the scratch snapshot path that must be cleaned up. Throws when
 * the config cannot be sourced from the index, which the per-file catch turns
 * into a loud skip. */
function configSnapshotFor(worktreeConfigPath, stagedConfig, depth = 0) {
  if (depth > 8) {
    throw new SkipError(
      'circular prettier config pointer; skipped auto-staging.',
    );
  }
  const configRel = relToCwd(worktreeConfigPath);
  const base = basename(worktreeConfigPath);
  const worktreeConfig = readFileSync(worktreeConfigPath);
  const configEqualsIndex = normalizedEquals(worktreeConfig, stagedConfig);

  // Provenance policy for config dependencies: verify relative
  // plugins/extends/imports only when this function is about to hand Prettier
  // a config path it derived from index content — a snapshot, or a pointer
  // target resolved from a staged package.json/package.yaml. Clean configs
  // returned as `null` are deliberately left to Prettier's own working-tree
  // loader (#10504), except package.yaml object configs, which can never be
  // snapshotted and are verified before being returned as `null`.

  if (base === 'package.json') {
    const stagedValue =
      JSON.parse(stripBom(stagedConfig.toString('utf8'))).prettier ?? null;

    if (typeof stagedValue === 'string') {
      if (!isConfigPointerPath(stagedValue)) {
        // `"prettier": "@company/prettier-config"` names a shareable config
        // package resolved from node_modules, not a file in this repository.
        // When package.json is clean Prettier resolves it exactly as before;
        // when the manifest diverges there is no index snapshot to hand
        // Prettier, so skip loudly instead of guessing a resolution.
        if (!configEqualsIndex) {
          throw new SkipError(
            `package.json's prettier key names the shareable config ` +
              `"${stagedValue}" but package.json has unstaged edits; skipped ` +
              'auto-staging so the uncommitted pointer stays out of the commit.',
          );
        }
        return { config: null, snapshotPath: null };
      }

      // `"prettier": "<path>"` points at another config file. Follow the
      // pointer with the same index-snapshot rules instead of letting
      // Prettier load the worktree copy of the pointed-to file. Normalize
      // Windows-style backslash separators before resolution.
      const targetPath = resolve(
        dirname(worktreeConfigPath),
        normalizeSpecifier(stagedValue),
      );
      const targetRel = relToCwd(targetPath);
      if (!targetRel) {
        throw new SkipError(
          `package.json's prettier key points outside the repository ` +
            `(${stagedValue}); skipped auto-staging.`,
        );
      }
      const stagedTarget = readIndexFile(targetRel);
      if (!stagedTarget) {
        throw new SkipError(
          `${targetRel} is not staged but package.json's prettier key ` +
            'points to it; skipped auto-staging so its uncommitted rules ' +
            'stay out of the commit. Stage or remove it and retry.',
        );
      }
      if (!existsSync(targetPath)) {
        throw new SkipError(
          `${targetRel} vanished from the working tree; skipped auto-staging.`,
        );
      }
      if (!normalizedEquals(readFileSync(targetPath), stagedTarget)) {
        return configSnapshotFor(targetPath, stagedTarget, depth + 1);
      }
      if (isJsConfig(targetPath)) {
        verifyJsConfigDeps(targetPath, stagedTarget);
      } else {
        verifyConfigDeps(targetPath, stagedTarget, false);
      }
      return { config: targetPath, snapshotPath: null };
    }

    if (configEqualsIndex) return { config: null, snapshotPath: null };
    verifyDepSpecs(stagedValue, dirname(worktreeConfigPath));
    const snapshotPath = writeConfigSnapshot(worktreeConfigPath, stagedConfig);
    return { config: snapshotPath, snapshotPath };
  }

  if (base === 'package.yaml') {
    let stagedValue = null;
    try {
      stagedValue =
        parseYaml(stripBom(stagedConfig.toString('utf8')))?.prettier ?? null;
    } catch {
      if (!configEqualsIndex) {
        throw new SkipError(
          `staged ${configRel} differs from the worktree copy and package.yaml ` +
            'configs cannot be snapshotted; skipped auto-staging.',
        );
      }
      // Prettier will report the YAML error when it loads the clean file.
      return { config: null, snapshotPath: null };
    }

    if (typeof stagedValue === 'string') {
      if (!isConfigPointerPath(stagedValue)) {
        // Bare package name (e.g. `@company/prettier-config`): Prettier
        // resolves it from node_modules. A clean manifest is left alone; a
        // diverged manifest cannot be snapshotted, so skip loudly.
        if (!configEqualsIndex) {
          throw new SkipError(
            `package.yaml's prettier key names the shareable config ` +
              `"${stagedValue}" but package.yaml has unstaged edits; skipped ` +
              'auto-staging so the uncommitted pointer stays out of the commit.',
          );
        }
        return { config: null, snapshotPath: null };
      }

      // Mirror the package.json string-pointer path: resolve the pointer
      // against the staged package.yaml, then source the pointed-to config
      // from the index (snapshotting it when it diverges).
      const targetPath = resolve(
        dirname(worktreeConfigPath),
        normalizeSpecifier(stagedValue),
      );
      const targetRel = relToCwd(targetPath);
      if (!targetRel) {
        throw new SkipError(
          `package.yaml's prettier key points outside the repository ` +
            `(${stagedValue}); skipped auto-staging.`,
        );
      }
      const stagedTarget = readIndexFile(targetRel);
      if (!stagedTarget) {
        throw new SkipError(
          `${targetRel} is not staged but package.yaml's prettier key ` +
            'points to it; skipped auto-staging so its uncommitted rules ' +
            'stay out of the commit. Stage or remove it and retry.',
        );
      }
      if (!existsSync(targetPath)) {
        throw new SkipError(
          `${targetRel} vanished from the working tree; skipped auto-staging.`,
        );
      }
      if (!normalizedEquals(readFileSync(targetPath), stagedTarget)) {
        return configSnapshotFor(targetPath, stagedTarget, depth + 1);
      }
      if (isJsConfig(targetPath)) {
        verifyJsConfigDeps(targetPath, stagedTarget);
      } else {
        verifyConfigDeps(targetPath, stagedTarget, false);
      }
      return { config: targetPath, snapshotPath: null };
    }

    if (!configEqualsIndex) {
      throw new SkipError(
        `staged ${configRel} differs from the worktree copy and package.yaml ` +
          'configs cannot be snapshotted; skipped auto-staging.',
      );
    }
    // Object-valued package.yaml has no snapshot path, so verify its relative
    // dependencies before handing the working-tree copy back to Prettier.
    verifyDepSpecs(stagedValue, dirname(worktreeConfigPath));
    return { config: null, snapshotPath: null };
  }

  if (isJsConfig(worktreeConfigPath)) {
    if (configEqualsIndex) return { config: null, snapshotPath: null };
    verifyJsConfigDeps(worktreeConfigPath, stagedConfig);
    const snapshotPath = writeConfigSnapshot(worktreeConfigPath, stagedConfig);
    return { config: snapshotPath, snapshotPath };
  }

  if (configEqualsIndex) return { config: null, snapshotPath: null };
  verifyConfigDeps(worktreeConfigPath, stagedConfig, true);
  const snapshotPath = writeConfigSnapshot(worktreeConfigPath, stagedConfig);
  return { config: snapshotPath, snapshotPath };
}

/** Format one staged path's index blob and stage the result. */
async function formatStagedFile(path) {
  const entries = git(['ls-files', '-s', '-z', '--', path])
    .toString()
    .split('\0')
    .filter(Boolean);
  if (entries.length !== 1) return; // unmerged or otherwise unusual state
  // 40-hex (SHA-1) or 64-hex (SHA-256) object names; git validates the rest.
  const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) (\d)\t/.exec(entries[0]);
  if (!match) return;
  const [, mode, sha, stage] = match;
  if (stage !== '0') return; // unmerged
  if (mode !== '100644' && mode !== '100755') return; // symlink or gitlink

  const stagedBlob = git(['cat-file', 'blob', sha]);
  if (stagedBlob.includes(0)) return; // binary
  const stagedText = stagedBlob.toString('utf8');

  try {
    if (isIgnored(path)) return;
  } catch (error) {
    if (error instanceof SkipError) {
      console.log(`${NOTICE} ${path}: ${error.message}`);
      return;
    }
    throw error;
  }

  // Prettier reads .prettierrc/.prettierignore from the working tree, but
  // the content being formatted comes from the index. The applicable config
  // must come from the index too: an untracked worktree config is not part of
  // the commit, so skip loudly rather than let its rules shape the staged
  // blob. When the tracked config has unstaged edits, resolve against a
  // snapshot of its index blob written beside the worktree copy, so
  // directory-relative overrides, plugins, and imports keep resolving against
  // the config's real location.
  let configSnapshot = null;
  try {
    let resolveConfigOptions = {};
    const worktreeConfigPath = await prettier.resolveConfigFile(path);
    if (worktreeConfigPath) {
      const configRel = relToCwd(worktreeConfigPath);
      if (configRel) {
        const stagedConfig = readIndexFile(configRel);
        if (!stagedConfig) {
          console.log(
            `${NOTICE} ${path}: ${configRel} is not staged; skipped ` +
              'auto-staging so its uncommitted rules stay out of the commit. ' +
              'Stage or remove it and retry.',
          );
          return;
        }
        let prepared;
        try {
          prepared = configSnapshotFor(worktreeConfigPath, stagedConfig);
        } catch (error) {
          if (error instanceof SkipError) {
            console.log(`${NOTICE} ${path}: ${error.message}`);
            return;
          }
          throw error;
        }
        configSnapshot = prepared.snapshotPath;
        resolveConfigOptions = prepared.config
          ? { config: prepared.config }
          : {};
      }
    }

    const config =
      (await prettier.resolveConfig(path, resolveConfigOptions)) ?? {};
    const formatted = await prettier.format(stagedText, {
      ...config,
      filepath: path,
    });
    if (formatted === stagedText) return;

    const newSha = git(['hash-object', '-w', '--stdin'], { input: formatted })
      .toString()
      .trim();
    git(['update-index', '--cacheinfo', `${mode},${newSha},${path}`]);
    console.log(`${NOTICE} staged Prettier output for ${path}`);

    mergeWorktree(path, stagedBlob, formatted);
  } finally {
    if (configSnapshot) rmSync(configSnapshot, { force: true });
  }
}

async function main() {
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  process.chdir(root);

  // Staged conflict resolutions during a merge are left untouched.
  const mergeHead = spawnSync('git', [
    'rev-parse',
    '--verify',
    '--quiet',
    'MERGE_HEAD',
  ]);
  if (mergeHead.status === 0) return;

  const staged = git([
    'diff',
    '--cached',
    '--name-only',
    '-z',
    '--diff-filter=ACMR',
  ])
    .toString()
    .split('\0')
    .filter(Boolean);

  for (const path of staged) {
    try {
      await formatStagedFile(path);
    } catch (error) {
      console.warn(`${NOTICE} skipping ${path}: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.warn(`${NOTICE} ${error.message}`);
});
