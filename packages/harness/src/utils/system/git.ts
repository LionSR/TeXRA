/**
 * How TeXRA runs git: the reads every host, tool and the harness itself ask
 * of a repository, under one timeout, and the one runner for a command that
 * changes something.
 *
 * A read never fails: a failed or timed-out `git` answers `false` or `null`,
 * and the caller says what that means for its own task. Interrupting the
 * calling fiber kills the `git` process (`executeCommand` owns that
 * teardown). Nothing here reads ambient state: `cwd` is the folder to read,
 * carried as data by whoever holds it.
 */

// Third-party imports
import { Effect, Stream } from 'effect';
import * as ChildProcess from 'effect/process/ChildProcess';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import { executeCommand } from './execUtils';
import { withCommandDirs } from './platformPaths';

const GIT_READ_TIMEOUT_MS = 10_000;

/** The trimmed stdout of a successful `git` read, `''` included, or null. */
function gitOutput(
  cwd: string,
  ...args: readonly string[]
): Effect.Effect<string | null, never, ChildProcessSpawner> {
  return executeCommand(['git', ...args], {
    cwd,
    timeout: GIT_READ_TIMEOUT_MS,
    quiet: true,
  }).pipe(
    Effect.map((result) => (result.success ? result.stdout.trim() : null)),
  );
}

/** The trimmed stdout of a successful, non-empty `git` read, or null. */
const gitValue = (cwd: string, ...args: readonly string[]) =>
  Effect.map(gitOutput(cwd, ...args), (value) => (value === '' ? null : value));

/**
 * Whether `cwd` is inside a git work tree. A bare repository and the inside
 * of `.git` are not: nothing there can be checked out or written to.
 * `undefined` means "no folder", which is not a repository.
 */
export function isGitRepository(
  cwd: string | undefined,
): Effect.Effect<boolean, never, ChildProcessSpawner> {
  if (!cwd) return Effect.succeed(false);
  return Effect.map(
    gitValue(cwd, 'rev-parse', '--is-inside-work-tree'),
    (value) => value === 'true',
  );
}

/** The top-level directory of the work tree holding `cwd`, or null. */
export function repositoryRoot(
  cwd: string,
): Effect.Effect<string | null, never, ChildProcessSpawner> {
  return gitValue(cwd, 'rev-parse', '--show-toplevel');
}

/**
 * The absolute git directory and top level of the checkout holding `cwd`, or
 * null when `cwd` is in no work tree or git could not say. A failure other
 * than "not a repository" is logged at warn.
 */
export const gitDirAndTopLevel = Effect.fn('git.gitDirAndTopLevel')(function* (
  cwd: string,
): Effect.fn.Return<
  { readonly gitDir: string; readonly topLevel: string } | null,
  never,
  ChildProcessSpawner
> {
  const result = yield* executeCommand(
    [
      'git',
      'rev-parse',
      '--path-format=absolute',
      '--git-dir',
      '--show-toplevel',
    ],
    { cwd, timeout: GIT_READ_TIMEOUT_MS, quiet: true },
  );
  const [gitDir = '', topLevel = ''] = result.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  if (result.success && gitDir !== '' && topLevel !== '')
    return { gitDir, topLevel };
  if (!/not a git repository|must be run in a work tree/i.test(result.stderr))
    yield* Effect.logWarning(
      `Cannot resolve the git repository of ${cwd}: ${result.stderr || 'git gave no answer'}`,
    ).pipe(withLogChannel('platform'));
  return null;
});

/** The URL of the `origin` remote, or null when there is none. */
export function originUrl(
  cwd: string,
): Effect.Effect<string | null, never, ChildProcessSpawner> {
  return gitValue(cwd, 'remote', 'get-url', 'origin');
}

/** The checked-out branch, or null when HEAD is detached or unreadable. */
export function currentBranch(
  cwd: string,
): Effect.Effect<string | null, never, ChildProcessSpawner> {
  return Effect.map(
    gitValue(cwd, 'rev-parse', '--abbrev-ref', 'HEAD'),
    (branch) => (branch === 'HEAD' ? null : branch),
  );
}

/**
 * The default branch `origin/HEAD` points at (`main` for `origin/main`), or
 * null when the clone has no such ref.
 */
export function originDefaultBranch(
  cwd: string,
): Effect.Effect<string | null, never, ChildProcessSpawner> {
  return Effect.map(
    gitValue(cwd, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'),
    (ref) =>
      ref?.startsWith('origin/') && ref.length > 'origin/'.length
        ? ref.slice('origin/'.length)
        : null,
  );
}

/** Whether the local branch `branch` exists. */
export function localBranchExists(
  cwd: string,
  branch: string,
): Effect.Effect<boolean, never, ChildProcessSpawner> {
  return Effect.map(
    gitOutput(cwd, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`),
    (value) => value !== null,
  );
}

/** Whether the work tree has changes `git status` reports, or null when git
 *  could not say. */
export function workTreeDirty(
  cwd: string,
): Effect.Effect<boolean | null, never, ChildProcessSpawner> {
  return Effect.map(gitOutput(cwd, 'status', '--porcelain'), (value) =>
    value === null ? null : value !== '',
  );
}

/** A commit hash, abbreviated (from 4 hex digits) or full. */
const COMMIT_HASH = /^[0-9a-fA-F]{4,40}$/;

/** Whether `hash` names a commit in the history of the repository at `cwd`. */
export function commitExists(
  cwd: string,
  hash: string,
): Effect.Effect<boolean, never, ChildProcessSpawner> {
  if (!COMMIT_HASH.test(hash)) return Effect.succeed(false);
  return Effect.map(
    gitOutput(cwd, 'rev-parse', '--verify', '--quiet', `${hash}^{commit}`),
    (value) => value !== null,
  );
}

/**
 * Up to `limit` recent commits, each labelled `<shortHash>: <subject>
 * (<relativeDate>)`, or null when `cwd` is not a work tree. A repository
 * with no commit, where `git log` fails, has none.
 */
export const recentCommitLabels = Effect.fn('git.recentCommitLabels')(
  function* (
    cwd: string,
    limit: number,
  ): Effect.fn.Return<readonly string[] | null, never, ChildProcessSpawner> {
    if (!(yield* isGitRepository(cwd))) return null;
    // `--no-pager` is portable; Windows lacks `cat` on PATH (#3817).
    const log = yield* gitOutput(
      cwd,
      '--no-pager',
      'log',
      '-n',
      String(limit),
      '--pretty=format:%h: %s (%cr)',
    );
    return (log ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  },
);

/**
 * Environment keys that let git invoke arbitrary helper programs (editors,
 * pagers, askpass, external-diff, config overrides). Stripped before handing
 * the environment to a non-interactive git subprocess so an inherited value
 * can't run a helper or redirect config during automated operations.
 */
const GIT_UNSAFE_ENV_KEYS = new Set([
  'editor',
  'git_askpass',
  'git_config_global',
  'git_config_system',
  'git_config_count',
  'git_config',
  'git_editor',
  'git_exec_path',
  'git_external_diff',
  'git_pager',
  'git_proxy_command',
  'git_sequence_editor',
  'git_template_dir',
  'pager',
  'prefix',
  'ssh_askpass',
]);

/**
 * The environment of a non-interactive git subprocess: the current
 * environment without the helper-invoking keys, `GIT_TERMINAL_PROMPT=0` so git
 * never blocks on a tty prompt, and `PATH` extended via {@link withCommandDirs}
 * so a GUI-launched host (whose minimal PATH may omit Homebrew,
 * `/usr/local/bin`, or Windows' `Git\cmd`) still resolves `git`. It strips only
 * because it replaces the child's environment (`extendEnv: false`).
 */
const machineGitEnv: Effect.Effect<NodeJS.ProcessEnv> = Effect.suspend(() => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !GIT_UNSAFE_ENV_KEYS.has(key.toLowerCase()),
    ),
  );
  env.GIT_TERMINAL_PROMPT = '0';
  return withCommandDirs(env);
});

/** How a {@link machineGit} command ended. */
export interface MachineGitResult {
  readonly stdout: string;
  /** Trimmed. */
  readonly stderr: string;
  readonly code: number;
}

/**
 * Run one `git` command that may change something (a clone, a fetch, a
 * checkout) under the machine git environment, with `env` added over it and
 * `input` on stdin. It drains both streams to the exit and fails only when
 * the process could not run; a non-zero exit is the caller's to word.
 */
export const machineGit = Effect.fn('git.machineGit')(function* (
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
  } = {},
) {
  const handle = yield* ChildProcess.make('git', [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...(yield* machineGitEnv), ...options.env },
    // A merge with `process.env` would bring back the stripped keys.
    extendEnv: false,
    stdin:
      options.input === undefined
        ? 'ignore'
        : Stream.make(new TextEncoder().encode(options.input)),
    detached: false,
    forceKillAfter: '5 seconds',
  });
  const [stdout, stderr, code] = yield* Effect.all(
    [
      handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
      handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: 'unbounded' },
  );
  return { stdout, stderr: stderr.trim(), code } satisfies MachineGitResult;
}, Effect.scoped);
