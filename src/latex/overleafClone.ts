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

import { Data, Effect, Stream } from 'effect';
import * as ChildProcess from 'effect/unstable/process/ChildProcess';
import { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

import {
  buildAuthenticatedRemoteUrl,
  buildGitCredential,
  overleafTokenSpec,
  redactSensitive,
  type GitCredential,
  type OverleafRemote,
  type OverleafTokenSpec,
} from '@latex/overleafProject';
import { executeCommand } from '@utils/system/execUtils';
import { makeMachineGitEnv } from '@utils/system/gitEnv';
import type { PlatformError } from 'effect/PlatformError';

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
  ): Effect.Effect<Iterable<string>, Error>;
  showWorkspaceUnreadable(error: unknown): Effect.Effect<void>;
  showWorkspaceNotEmpty(): Effect.Effect<void>;

  /** Fails when `git clone` does. */
  runClone(
    remoteUrl: string,
    workspacePath: string,
  ): Effect.Effect<void, Error, ChildProcessSpawner>;
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
  | { status: 'ready'; credential: GitCredential }
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
    return { status: 'ready', credential: buildGitCredential(stored) };
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
  return { status: 'ready', credential: buildGitCredential(input) };
});

const checkOverleafClonePreconditions = Effect.fn(
  'overleaf.checkClonePreconditions',
)(function* (
  workspacePath: string,
  ports: OverleafCloneWorkflowPorts,
): Effect.fn.Return<
  ClonePreconditionFailure | null,
  never,
  ChildProcessSpawner
> {
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
 * `git clone` ended without a clone. `message` is git's own stderr (or the
 * exit or start failure when it printed none), never the argv or a
 * `PlatformError` message: the remote URL carries the token.
 */
class GitCloneFailed extends Data.TaggedError('GitCloneFailed')<{
  readonly exitCode: number | undefined;
  readonly message: string;
}> {}

/**
 * Clone `remoteUrl` into the existing directory `into`, with the machine git
 * environment only: `extendEnv: false`, because `makeMachineGitEnv` omits the
 * credential-helper keys a merge with `process.env` would bring back.
 */
export const gitClone = Effect.fn('overleafClone.gitClone')(function* (
  remoteUrl: string,
  into: string,
): Effect.fn.Return<void, GitCloneFailed, ChildProcessSpawner> {
  const cloned = yield* Effect.gen(function* () {
    const handle = yield* ChildProcess.make('git', ['clone', remoteUrl, '.'], {
      cwd: into,
      env: makeMachineGitEnv(),
      extendEnv: false,
      stdin: 'ignore',
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
  }).pipe(
    Effect.scoped,
    Effect.mapError(
      (error: PlatformError) =>
        new GitCloneFailed({
          exitCode: undefined,
          message: `git clone did not complete: ${error.reason._tag}`,
        }),
    ),
  );
  if (cloned.code !== 0) {
    return yield* new GitCloneFailed({
      exitCode: cloned.code,
      message: cloned.stderr || `git clone exited with code ${cloned.code}`,
    });
  }
});

function isCloneAuthError(e: unknown): boolean {
  return (
    e instanceof Error && /auth|401|403|fatal: could not read/i.test(e.message)
  );
}

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
  ): Effect.fn.Return<OverleafCloneOutcome, Error, ChildProcessSpawner> {
    const preconditionFailure = yield* checkOverleafClonePreconditions(
      workspacePath,
      ports,
    );
    if (preconditionFailure) return preconditionFailure;

    const token = yield* resolveOverleafToken(remote, ports);
    if (token.status !== 'ready') return token;

    const remoteUrl = buildAuthenticatedRemoteUrl(remote, token.credential);
    const label = remote.isOverleaf ? 'Overleaf' : 'ShareLaTeX';

    return yield* ports.runClone(remoteUrl, workspacePath).pipe(
      Effect.flatMap(() =>
        ports
          .showCloneSucceeded(label)
          .pipe(Effect.as<OverleafCloneOutcome>({ status: 'success' })),
      ),
      Effect.catch((error) =>
        Effect.gen(function* () {
          const authError = isCloneAuthError(error);
          if (authError) {
            yield* ports.deleteStoredToken(overleafTokenSpec(remote).tokenKey);
            yield* ports.showAuthFailure(remote);
          } else {
            yield* ports.showCloneFailed(
              'Clone failed. Check credentials and connection.',
            );
          }
          yield* ports.logCloneError(
            redactSensitive(error.message, token.credential.sensitive),
          );
          return {
            status: authError ? 'authFailure' : 'cloneFailed',
          } satisfies OverleafCloneOutcome;
        }),
      ),
    );
  },
);
