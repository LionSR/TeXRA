/**
 * Host-neutral Overleaf / ShareLaTeX clone workflow: token caching and
 * validation, clone-precondition checks, and clone execution with
 * auth-failure handling (clears the bad token and reports the failure; does
 * not retry the clone itself). Reaches every side effect (secret storage,
 * prompts, the actual `git clone`, and user-facing messages) through
 * `ports`, so the decision logic is unit-testable and reusable by any host —
 * not just the VS Code command it was extracted from.
 *
 * Every port is an Effect: the workflow is one program the host runs at its
 * own entry, so a cancelled clone interrupts the prompt and the subprocess
 * instead of running them out.
 */

import { Data, Effect, type FileSystem, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import {
  overleafGitClone,
  overleafTokenSpec,
  type OverleafGitClone,
  type OverleafRemote,
  type OverleafTokenSpec,
} from '@latex/overleafProject';
import { withLogChannel } from '@logger/effectLog';
import { executeCommand } from '@utils/system/execUtils';
import { makeMachineGitEnv } from '@utils/system/gitEnv';
import type { PlatformError } from 'effect/PlatformError';

/** What the clone workflow and its host ports run on: git, and the filesystem
 *  for the destination probe and its creation. */
type CloneServices = ChildProcessSpawner | FileSystem.FileSystem;

/** Files ignored when deciding whether a workspace is "empty enough" to clone into. */
const IGNORED_CLONE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

export interface OverleafCloneWorkflowPorts {
  getStoredToken(key: string): Effect.Effect<string | undefined>;
  deleteStoredToken(key: string): Effect.Effect<void>;
  storeToken(key: string, token: string): Effect.Effect<void>;
  /**
   * Prompt for a new token; null when the user cancels. Fails when the host
   * cannot prompt at all (a non-interactive CLI run, say) — that is a usage
   * error for the caller to report, not a cancelled clone.
   */
  promptToken(spec: OverleafTokenSpec): Effect.Effect<string | null, Error>;
  /** Surface an invalid-token-format error for the given spec. */
  showInvalidToken(
    spec: OverleafTokenSpec,
    message: string,
  ): Effect.Effect<void>;

  /** `git` isn't on PATH — surface install guidance. */
  showGitMissing(): Effect.Effect<void>;
  /** Fails when the directory can't be read at all. */
  listWorkspaceEntries(
    workspacePath: string,
  ): Effect.Effect<Iterable<string>, Error, FileSystem.FileSystem>;
  showWorkspaceUnreadable(error: unknown): Effect.Effect<void>;
  showWorkspaceNotEmpty(): Effect.Effect<void>;

  /** Run {@link gitClone} for `clone`. Fails when `git clone` does. */
  runClone(
    clone: OverleafGitClone,
    workspacePath: string,
  ): Effect.Effect<void, Error, CloneServices>;
  showCloneSucceeded(label: string): Effect.Effect<void>;
  /** The clone failed for what looks like an auth reason (bad/expired token). */
  showAuthFailure(remote: OverleafRemote): Effect.Effect<void>;
  showCloneFailed(message: string): Effect.Effect<void>;
  logCloneError(message: string): Effect.Effect<void>;
}

type OverleafCloneOutcome =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'invalidToken' }
  | { status: 'gitMissing' }
  | { status: 'workspaceUnreadable' }
  | { status: 'workspaceNotEmpty' }
  | { status: 'authFailure' }
  | { status: 'cloneFailed' };

type TokenResolution =
  | { status: 'ready'; token: string }
  | { status: 'cancelled' }
  | { status: 'invalidToken' };

type ClonePreconditionFailure =
  | { status: 'gitMissing' }
  | { status: 'workspaceUnreadable' }
  | { status: 'workspaceNotEmpty' };

const resolveOverleafToken = Effect.fn('overleaf.resolveToken')(function* (
  remote: OverleafRemote,
  ports: OverleafCloneWorkflowPorts,
): Effect.fn.Return<TokenResolution, Error> {
  const spec = overleafTokenSpec(remote);
  const isValid = (t: string): boolean => spec.tokenValidator?.(t) ?? true;

  const stored = (yield* ports.getStoredToken(spec.tokenKey))?.trim() ?? '';
  if (stored && isValid(stored)) {
    return { status: 'ready', token: stored };
  }
  if (stored) yield* ports.deleteStoredToken(spec.tokenKey);

  const input = yield* ports.promptToken(spec);
  if (!input) return { status: 'cancelled' };

  if (!isValid(input)) {
    const message = spec.tokenHint
      ? `Invalid token format. ${spec.tokenHint}`
      : 'Invalid token format.';
    yield* ports.showInvalidToken(spec, message);
    return { status: 'invalidToken' };
  }

  yield* ports.storeToken(spec.tokenKey, input);
  return { status: 'ready', token: input };
});

const checkOverleafClonePreconditions = Effect.fn(
  'overleaf.checkClonePreconditions',
)(function* (
  workspacePath: string,
  ports: OverleafCloneWorkflowPorts,
): Effect.fn.Return<ClonePreconditionFailure | null, never, CloneServices> {
  // Directory-independent: the clone target may not exist yet.
  const gitVersion = yield* executeCommand(['git', '--version'], {
    cwd: process.cwd(),
    settings: undefined,
    quiet: true,
  });
  if (!gitVersion.success) {
    yield* ports.showGitMissing();
    return { status: 'gitMissing' };
  }

  const entries = yield* ports
    .listWorkspaceEntries(workspacePath)
    .pipe(
      Effect.catch((error) =>
        ports
          .showWorkspaceUnreadable(error)
          .pipe(Effect.as<Iterable<string> | null>(null)),
      ),
    );
  if (entries === null) return { status: 'workspaceUnreadable' };

  if ([...entries].some((name) => !IGNORED_CLONE_FILES.has(name))) {
    yield* ports.showWorkspaceNotEmpty();
    return { status: 'workspaceNotEmpty' };
  }

  return null;
});

/**
 * `git clone` ended without a clone. `message` is git's own stderr, the exit
 * code when it printed none, or, when git could not be run at all, the
 * PlatformError's own message after a fixed prefix (for a spawn failure,
 * `Tag: Module.method (pathOrDescriptor)`, with a description only when the
 * spawner supplies one).
 */
export class GitCloneFailed extends Data.TaggedError('GitCloneFailed')<{
  readonly exitCode: number | undefined;
  readonly message: string;
}> {}

/**
 * Run one `git` command in `cwd` with the machine git environment plus
 * `env`: `extendEnv: false`, because `makeMachineGitEnv` omits the
 * credential-helper keys a merge with `process.env` would bring back.
 */
const runGit = (
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  input?: string,
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make('git', [...args], {
      cwd,
      env: { ...makeMachineGitEnv(), ...env },
      extendEnv: false,
      stdin:
        input === undefined
          ? 'ignore'
          : Stream.make(new TextEncoder().encode(input)),
      stdout: 'ignore',
      detached: false,
      forceKillAfter: '5 seconds',
    });
    const [stderr, code] = yield* Effect.all(
      [
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 'unbounded' },
    );
    return { stderr: stderr.trim(), code };
  }).pipe(Effect.scoped);

/**
 * git translates its messages; the clone runs in the C locale so its stderr
 * carries the English wording {@link GIT_AUTH_FAILURE} matches.
 */
const GIT_C_LOCALE = { LC_ALL: 'C', LANGUAGE: 'C' } as const;

/**
 * Run `clone` in the existing directory `into`, then `git credential
 * approve` with its `approval`. The approval only offers the token to the
 * user's credential helper, so its failure is logged at warn rather than
 * failing a clone that succeeded.
 */
export const gitClone = Effect.fn('overleafClone.gitClone')(function* (
  clone: OverleafGitClone,
  into: string,
): Effect.fn.Return<void, GitCloneFailed, ChildProcessSpawner> {
  const cloned = yield* runGit(clone.args, into, {
    ...clone.env,
    ...GIT_C_LOCALE,
  }).pipe(
    Effect.mapError(
      (error: PlatformError) =>
        new GitCloneFailed({
          exitCode: undefined,
          message: `git clone did not complete: ${error.message}`,
        }),
    ),
  );
  if (cloned.code !== 0) {
    return yield* new GitCloneFailed({
      exitCode: cloned.code,
      message: cloned.stderr || `git clone exited with code ${cloned.code}`,
    });
  }
  const approved = yield* Effect.result(
    runGit(['credential', 'approve'], into, {}, clone.approval),
  );
  let approveFailure: string | undefined;
  if (approved._tag === 'Failure') {
    approveFailure = approved.failure.message;
  } else if (approved.success.code !== 0) {
    approveFailure = `exit ${approved.success.code}: ${approved.success.stderr}`;
  }
  if (approveFailure !== undefined) {
    yield* Effect.logWarning(
      `git credential approve failed (${approveFailure}). The clone succeeded; git will ask for the token on the next pull or push.`,
    ).pipe(withLogChannel('overleafClone'));
  }
});

/** git's own wording for a rejected credential; never URL or path text. */
const GIT_AUTH_FAILURE =
  /Authentication failed for|could not read (Username|Password) for|The requested URL returned error: 40[13]/;

/**
 * Only git exiting 128 with its own credential-rejection wording counts as an
 * auth failure. A host error before git ran (a mkdir or realPath failure) or
 * a network failure is a plain clone failure, so the stored token survives.
 */
const isCloneAuthError = (error: Error): boolean =>
  error instanceof GitCloneFailed &&
  error.exitCode === 128 &&
  GIT_AUTH_FAILURE.test(error.message);

/**
 * Resolve credentials, verify clone preconditions, and clone an
 * Overleaf/ShareLaTeX project into an empty workspace. `remote` must already
 * be a parsed, validated target (see `parseLatexGitUrl`) — URL parsing and
 * workspace-selection stay with the caller, since those are trivial,
 * host-specific guard clauses rather than shared workflow logic.
 */
export const cloneOverleafProject = Effect.fn('overleaf.cloneProject')(
  function* (
    remote: OverleafRemote,
    workspacePath: string,
    ports: OverleafCloneWorkflowPorts,
  ): Effect.fn.Return<OverleafCloneOutcome, Error, CloneServices> {
    const preconditionFailure = yield* checkOverleafClonePreconditions(
      workspacePath,
      ports,
    );
    if (preconditionFailure) return preconditionFailure;

    const token = yield* resolveOverleafToken(remote, ports);
    if (token.status !== 'ready') return token;

    const label = remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';

    return yield* ports
      .runClone(overleafGitClone(remote, token.token), workspacePath)
      .pipe(
        Effect.flatMap(() =>
          ports
            .showCloneSucceeded(label)
            .pipe(Effect.as<OverleafCloneOutcome>({ status: 'success' })),
        ),
        Effect.catch((error) =>
          Effect.gen(function* () {
            const authError = isCloneAuthError(error);
            if (authError) {
              yield* ports.deleteStoredToken(
                overleafTokenSpec(remote).tokenKey,
              );
              yield* ports.showAuthFailure(remote);
            } else {
              yield* ports.showCloneFailed(
                'Clone failed. Check credentials and connection.',
              );
            }
            // The token travels in no argument or URL, so git's message
            // cannot carry it.
            yield* ports.logCloneError(error.message);
            return {
              status: authError ? 'authFailure' : 'cloneFailed',
            } satisfies OverleafCloneOutcome;
          }),
        ),
      );
  },
);
