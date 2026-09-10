#!/usr/bin/env node
// Run only the kernel suites a change can affect — the fast signal for the
// edit → commit loop.
//
// `npm test` runs every suite under src/test-kernel/. That is the right gate
// for CI and before opening a pull request, but it is too slow to sit in front
// of every local commit, so in practice it gets skipped and the breakage
// surfaces on CI instead. This script asks git what changed and hands the list
// to `vitest related`, which keeps only the suites whose module graph reaches
// one of those files.
//
// Two things the module graph cannot see, handled explicitly rather than
// quietly dropped:
//
//   * Repo-scanning suites. The architecture ratchets — plus a handful of
//     catalog and contract suites — read the repository from disk through
//     src/test-kernel/support/repoScan.ts instead of importing the code they
//     check, so no import edge connects them to a changed source file. They are
//     also exactly the guards a refactor trips. Seeding `related` with
//     repoScan.ts itself selects every suite that imports it, so they run
//     whenever a code file changed and there is no list to keep in sync here.
//   * The harness itself. A change to the Vitest config, the path aliases, the
//     shared test-support modules, or a dependency manifest invalidates the
//     mapping rather than being covered by it, so those fall back to the full
//     suite instead of trusting a stale graph.
//
// A changed file that cannot appear in a module graph at all (a YAML resource,
// an image, a fixture `.md`) is named in a notice instead of being silently
// ignored: `related` will not select a suite for it, and the notice is the only
// signal that the targeted run is narrower than the change.
//
// This is a pre-commit signal, not a replacement for `npm test`.

import { spawnSync } from 'node:child_process';
import { extname } from 'node:path';
import process from 'node:process';

const NOTICE = '[test-changed]';

const VITEST_CONFIG = 'vitest.config.mjs';

/** Selecting this pulls in every suite that scans the repo from disk. */
const REPO_SCAN_SEED = 'src/test-kernel/support/repoScan.ts';

/**
 * Extensions that can appear in the Vite module graph, and so can be resolved
 * back to the suites importing them. `.tex` is here because vitest.config.mjs
 * loads templates through a plugin; anything outside this set is reported as
 * unmapped rather than passed to `related`, which would match nothing.
 */
const GRAPH_EXTENSIONS = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.mts',
  '.tex',
  '.ts',
  '.tsx',
]);

/** Prefixes holding code or resources a kernel suite can observe. */
const CODE_ROOTS = [
  'config/',
  'packages/',
  'prompts/',
  'scripts/',
  'src/',
  'supabase/',
];

/** Run a git command, returning stdout; throw on failure. */
function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Split a NUL-delimited git list into paths. */
function paths(stdout) {
  return stdout.split('\0').filter(Boolean);
}

/**
 * Why the full suite must run instead of a targeted one. Returns null when the
 * change is safe to map through the module graph.
 *
 * `src/test-kernel/support/` is listed wholesale, not narrowed to the modules
 * the config loads as `setupFiles`: those apply to every suite, and deciding
 * which of the directory's modules they reach transitively is the same graph
 * question this script is trying to answer cheaply. The directory changes
 * rarely, so over-triggering there costs little and never under-tests.
 */
function fullRunReason(changed) {
  for (const path of changed) {
    if (path === VITEST_CONFIG) return `${path} changed`;
    if (path === 'tsconfig.json' || path === 'scripts/aliases.mjs') {
      return `${path} changed (path aliases feed the module graph)`;
    }
    if (path === 'pnpm-lock.yaml' || path === 'pnpm-workspace.yaml') {
      return `${path} changed`;
    }
    if (path === 'package.json' || path.endsWith('/package.json')) {
      return `${path} changed`;
    }
    if (path.startsWith('src/test-kernel/support/')) {
      return `${path} changed (shared test harness)`;
    }
  }
  return null;
}

function isCode(path) {
  return CODE_ROOTS.some((root) => path.startsWith(root));
}

/** Collect the changed paths for the requested comparison. */
function changedPaths({ staged, since }) {
  const filter = '--diff-filter=ACMR';
  if (staged) {
    return paths(git(['diff', '--cached', '--name-only', '-z', filter]));
  }
  // Working-tree mode: staged and unstaged edits against HEAD, plus files git
  // does not track yet — a new module and its new suite are the common case
  // and both are untracked until the first `git add`.
  const base = since ? `${since}...HEAD` : 'HEAD';
  return [
    ...paths(git(['diff', '--name-only', '-z', filter, base])),
    ...(since ? paths(git(['diff', '--name-only', '-z', filter, 'HEAD'])) : []),
    ...paths(git(['ls-files', '--others', '--exclude-standard', '-z'])),
  ];
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    passthrough: [],
    since: null,
    staged: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true, ...options };
    if (arg === '--staged') {
      options.staged = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--since') {
      options.since = argv[(index += 1)];
      if (!options.since) throw new Error('--since needs a git ref');
    } else if (arg.startsWith('--since=')) {
      options.since = arg.slice('--since='.length);
    } else if (arg !== '--') {
      // Everything else is a Vitest flag or filter: -t, --bail, --reporter, …
      // A bare `--` is dropped rather than forwarded: Vitest's parser reads it
      // as end-of-flags, which would turn every following flag into a
      // positional filter and silently replace the computed seed list.
      options.passthrough.push(arg);
    }
  }
  if (options.staged && options.since) {
    throw new Error('--staged and --since are mutually exclusive');
  }
  return options;
}

const HELP = `Usage: node scripts/test-changed.mjs [options] [-- vitest args]

Runs the kernel suites reachable from the files you changed, plus the suites
that scan the repository from disk. Use \`npm test\` for the full gate.

  --staged        Only files staged for commit (the pre-commit view).
  --since <ref>   Files changed since <ref>, plus the working tree.
  --dry-run       Print the decision and the Vitest command, run nothing.
  -h, --help      Show this message.

Unrecognized arguments are forwarded to Vitest, so \`-t <pattern>\`,
\`--bail 1\` and \`--reporter dot\` all work.`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(HELP);
    return 0;
  }

  process.chdir(git(['rev-parse', '--show-toplevel']).trim());

  const changed = [...new Set(changedPaths(options))].sort();
  const scope = options.staged
    ? 'staged'
    : options.since
      ? `since ${options.since}`
      : 'working tree';
  if (changed.length === 0) {
    console.log(`${NOTICE} no ${scope} changes; nothing to run.`);
    return 0;
  }

  const reason = fullRunReason(changed);
  if (reason) {
    console.log(`${NOTICE} ${reason}; running the full suite.`);
    return run(
      ['run', '--config', VITEST_CONFIG, ...options.passthrough],
      options.dryRun,
    );
  }

  const code = changed.filter(isCode);
  if (code.length === 0) {
    console.log(
      `${NOTICE} ${changed.length} changed file(s), none under ${CODE_ROOTS.join(', ')}; nothing to run.`,
    );
    return 0;
  }

  const seeds = code.filter((path) => GRAPH_EXTENSIONS.has(extname(path)));
  const unmapped = code.filter((path) => !GRAPH_EXTENSIONS.has(extname(path)));
  if (unmapped.length > 0) {
    // Loud on purpose: nothing imports these, so no suite is selected for them
    // and only the repo-scanning suites will look at them at all.
    console.log(
      `${NOTICE} not in the module graph, so only the repo-scanning suites ` +
        `cover them — run \`npm test\` if a suite reads one:\n  ${unmapped.join('\n  ')}`,
    );
  }

  console.log(
    `${NOTICE} ${scope}: ${changed.length} changed file(s) -> ${seeds.length} module graph seed(s) + the repo-scanning suites.`,
  );
  return run(
    [
      'related',
      '--run',
      '--config',
      VITEST_CONFIG,
      // `related` can select nothing (a change no suite reaches); that is a
      // result, not the misconfiguration the config's passWithNoTests=false
      // guards against.
      '--passWithNoTests',
      ...options.passthrough,
      ...seeds,
      REPO_SCAN_SEED,
    ],
    options.dryRun,
  );
}

/** Run Vitest through the workspace's own package manager. */
function run(args, dryRun) {
  const command = ['corepack', 'pnpm', 'exec', 'vitest', ...args];
  if (dryRun) {
    console.log(`${NOTICE} would run: ${command.join(' ')}`);
    return 0;
  }
  const [bin, ...rest] = command;
  const result = spawnSync(bin, rest, { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`${NOTICE} ${error.message}`);
  process.exit(1);
}
